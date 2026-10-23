import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import { k, getProfile } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { PLANS, deriveMonthlyEvents, planForLookupKey, type PlanId } from "./plans";

export interface BillingRecord {
	org_id: string;
	customer_id: string;
	subscription_id: string | null;
	status: string;
	plan: PlanId;
	// ISO timestamps; PROFILE carries the same instants as dates.
	current_period_start: string | null;
	current_period_end: string | null;
	cancel_at_period_end: boolean;
	// USD, null = no cap. Set through the console, never by the webhook.
	spend_cap_usd: number | null;
	past_due_since: string | null;
	// The meter's counters: what it last reported to Stripe, and for which period.
	reported_events: number;
	reported_period: string | null;
	// A meter event claimed (counters already advanced) but not yet confirmed sent. Written and
	// cleared only by the meter; the next run re-sends exactly this before anything new.
	pending?: PendingMeterEvent;
}

export interface PendingMeterEvent {
	identifier: string;
	value: string;
	// Epoch seconds, as Stripe takes it.
	timestamp: number;
	period: string;
}

const GRACE_MS = 7 * 86_400_000;
const EVENT_TTL_SECONDS = 30 * 86_400;
const table = () => process.env.ACCOUNTS_TABLE;
const billingKey = (orgId: string) => ({ pk: k.org(orgId), sk: "BILLING" });
const customerKey = (customerId: string) => ({ pk: `STRIPE#${customerId}`, sk: "CUSTOMER" });
const eventKey = (eventId: string) => ({ pk: `STRIPE_EVENT#${eventId}`, sk: "EVENT" });

export async function getBilling(orgId: string): Promise<BillingRecord | null> {
	const { Item } = await ddb.send(new GetCommand({ TableName: table(), Key: billingKey(orgId) }));
	if (!Item) return null;
	const { pk: _pk, sk: _sk, ...record } = Item;
	return record as BillingRecord;
}

export async function orgForCustomer(customerId: string): Promise<string | null> {
	const { Item } = await ddb.send(new GetCommand({ TableName: table(), Key: customerKey(customerId) }));
	return (Item?.org_id as string | undefined) ?? null;
}

export async function linkCustomer(orgId: string, customerId: string): Promise<void> {
	await ddb.send(new PutCommand({ TableName: table(), Item: { ...customerKey(customerId), org_id: orgId } }));
}

// The base (flat monthly) item decides the plan; the metered item only carries usage.
function baseItem(sub: Stripe.Subscription) {
	const baseKeys = new Set(Object.values(PLANS).flatMap((p) => (p.stripe ? [p.stripe.base] : [])));
	return sub.items.data.find((i) => !!i.price?.lookup_key && baseKeys.has(i.price.lookup_key));
}

// Recent API versions (stripe 23) put the period on each subscription item; older ones put it on
// the subscription. Read the base item first, then the subscription, so either shape works.
function periodOf(sub: Stripe.Subscription): { start: number | null; end: number | null } {
	const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
	const item = baseItem(sub) ?? sub.items.data[0];
	return {
		start: item?.current_period_start ?? legacy.current_period_start ?? null,
		end: item?.current_period_end ?? legacy.current_period_end ?? null,
	};
}

// The plan a subscription entitles the org to right now. null means "make no change"
// (an unfinished checkout, or a state or price we don't recognise), and the caller skips.
export function effectivePlan(sub: Stripe.Subscription | null, pastDueSince: string | null, now = Date.now()): PlanId | null {
	if (!sub) return "free";
	switch (sub.status) {
		case "canceled":
		case "unpaid":
		case "incomplete_expired":
		// Collection is paused, so nothing is being paid for.
		case "paused":
			return "free";
		case "active":
		case "trialing": {
			const key = baseItem(sub)?.price.lookup_key;
			return key ? planForLookupKey(key) : null;
		}
		case "past_due": {
			// A first failure has no stamp yet, and a stamp we can't parse is not grounds to downgrade.
			if (pastDueSince && now - Date.parse(pastDueSince) > GRACE_MS) return "free";
			const key = baseItem(sub)?.price.lookup_key;
			return key ? planForLookupKey(key) : null;
		}
		// incomplete and anything Stripe adds later.
		default:
			return null;
	}
}

const iso = (seconds: number | null) => (seconds === null ? null : new Date(seconds * 1000).toISOString());
const customerIdOf = (sub: Stripe.Subscription) => (typeof sub.customer === "string" ? sub.customer : sub.customer.id);

// A DynamoDB transaction cancellation lists a reason per item, in order: PROFILE first, then BILLING.
const conditionFailedAt = (e: unknown, index: number) => {
	const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
	return err.name === "TransactionCanceledException" && err.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed";
};

const LIVE = new Set(["active", "trialing", "past_due"]);
const TERMINAL = new Set(["canceled", "unpaid", "incomplete_expired"]);

export interface ApplyResult {
	// Callers must branch on `applied`: when false this is only the best-known plan, not what was written.
	plan: PlanId;
	// The Stripe billing period moved since the BILLING item was written, so the meter owes the old one a flush.
	periodChanged: boolean;
	previous: BillingRecord | null;
	// False when nothing was written: incomplete or stale subscription, or a custom, missing or non-active org.
	applied: boolean;
}

export async function applySubscription(orgId: string, sub: Stripe.Subscription | null, now = Date.now()): Promise<ApplyResult> {
	// One retry: the only expected conflict is a spend-cap change landing between our read and write.
	for (let attempt = 0; ; attempt++) {
		const result = await tryApply(orgId, sub, now, attempt === 0);
		if (result) return result;
	}
}

// Returns null when the spend cap changed under us and a fresh read may still succeed.
async function tryApply(orgId: string, sub: Stripe.Subscription | null, now: number, mayRetry: boolean): Promise<ApplyResult | null> {
	const [previous, profile] = await Promise.all([getBilling(orgId), getProfile(orgId)]);
	// A late event for an old subscription (say its final invoice after a cancel and resubscribe) is
	// re-fetched as canceled; applying it would downgrade the org's newer live subscription.
	if (previous?.subscription_id && sub && sub.id !== previous.subscription_id && LIVE.has(previous.status) && TERMINAL.has(sub.status)) {
		console.warn(`ignoring stale subscription for org ${orgId}: ${sub.id} (${sub.status}) while ${previous.subscription_id} is ${previous.status}`);
		return { plan: previous.plan, periodChanged: false, previous, applied: false };
	}
	const pastDueSince = sub?.status === "past_due" ? (previous?.past_due_since ?? new Date(now).toISOString()) : null;
	const plan = effectivePlan(sub, pastDueSince, now);
	const skipped = (): ApplyResult => ({ plan: plan ?? previous?.plan ?? "free", periodChanged: false, previous, applied: false });
	if (plan === null || !profile || profile.status !== "active" || profile.plan === "custom") return skipped();

	const period = sub ? periodOf(sub) : { start: null, end: null };
	const periodStart = iso(period.start);
	const periodEnd = iso(period.end);
	const planDef = PLANS[plan];
	const readCap = previous?.spend_cap_usd ?? null;
	const limits = { ...planDef.limits, monthly_events: deriveMonthlyEvents(planDef, readCap) };
	// Free has no Stripe period; a paid one without dates (never seen in practice) falls back to the calendar month.
	const withPeriod = plan !== "free" && !!periodStart && !!periodEnd;
	const customerId = sub ? customerIdOf(sub) : (previous?.customer_id ?? null);

	const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
		{
			Update: {
				TableName: table(),
				Key: { pk: k.org(orgId), sk: "PROFILE" },
				// Only a live, self-serve org: custom plans are managed by hand and a deleting org must stay put.
				ConditionExpression: "#s = :active AND #p <> :custom",
				UpdateExpression:
					"SET #p = :plan, limits = :limits, retention_days = :retention" +
					(withPeriod ? ", period_start = :ps, period_end = :pe" : " REMOVE period_start, period_end"),
				ExpressionAttributeNames: { "#s": "status", "#p": "plan" },
				ExpressionAttributeValues: {
					":active": "active",
					":custom": "custom",
					":plan": plan,
					":limits": limits,
					":retention": planDef.retention_days,
					...(withPeriod ? { ":ps": periodStart.slice(0, 10), ":pe": periodEnd.slice(0, 10) } : {}),
				},
			},
		},
	];
	// No customer means nothing to record yet (a deleted subscription for an org that never had one).
	if (customerId) {
		items.push({
			Update: {
				TableName: table(),
				Key: billingKey(orgId),
				// limits above were derived from the cap we read; if the console changed it since, redo the read.
				ConditionExpression: "attribute_not_exists(spend_cap_usd) OR spend_cap_usd = :readCap",
				// The cap and the meter's counters belong to other writers, so they are only initialised here.
				UpdateExpression:
					"SET customer_id = :cus, subscription_id = :sub, #s = :status, #p = :plan, current_period_start = :cps, current_period_end = :cpe, " +
					"cancel_at_period_end = :cancel, past_due_since = :pd, org_id = :org, " +
					"spend_cap_usd = if_not_exists(spend_cap_usd, :cap), reported_events = if_not_exists(reported_events, :zero), reported_period = if_not_exists(reported_period, :none)",
				ExpressionAttributeNames: { "#s": "status", "#p": "plan" },
				ExpressionAttributeValues: {
					":org": orgId,
					":cus": customerId,
					":sub": sub?.id ?? null,
					":status": sub?.status ?? "canceled",
					":plan": plan,
					":cps": periodStart,
					":cpe": periodEnd,
					":cancel": sub?.cancel_at_period_end ?? false,
					":pd": pastDueSince,
					":cap": null,
					":readCap": readCap,
					":zero": 0,
					":none": null,
				},
			},
		});
	}

	try {
		await ddb.send(new TransactWriteCommand({ TransactItems: items }));
	} catch (e) {
		// The org was suspended, deleted or made custom after we read it: skipped, not an error.
		if (conditionFailedAt(e, 0)) return skipped();
		if (customerId && conditionFailedAt(e, 1) && mayRetry) return null;
		throw e;
	}
	const periodChanged = !!previous?.current_period_start && previous.current_period_start !== periodStart;
	return { plan, periodChanged, previous, applied: true };
}

// First delivery wins: false means Stripe already sent this event and it was recorded.
export async function recordEventOnce(eventId: string, type: string): Promise<boolean> {
	const now = Date.now();
	try {
		await ddb.send(
			new PutCommand({
				TableName: table(),
				Item: { ...eventKey(eventId), type, received_at: new Date(now).toISOString(), expires_at: Math.floor(now / 1000) + EVENT_TTL_SECONDS },
				ConditionExpression: "attribute_not_exists(pk)",
			}),
		);
		return true;
	} catch (e) {
		if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
		throw e;
	}
}

// Lets Stripe's retry reprocess an event whose handling failed after it was recorded.
export async function forgetEvent(eventId: string): Promise<void> {
	await ddb.send(new DeleteCommand({ TableName: table(), Key: eventKey(eventId) }));
}
