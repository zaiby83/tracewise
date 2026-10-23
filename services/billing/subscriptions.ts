import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
	// Set by applySubscription in the same write that moves BILLING off a period, cleared (conditionally on
	// `period`) by whoever has reported that period. It outlives a failed flush, so the final usage of a
	// period can't be forgotten once BILLING no longer shows it.
	flush_due?: FlushDue;
}

export interface FlushDue {
	// YYYY-MM-DD, the counter key of the period still owed a report.
	period: string;
	// ISO instant; late events are stamped no later than just before it.
	period_end: string;
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

// A customer belongs to one org for good: relinking it to another would send that customer's billing events to the wrong org.
export async function linkCustomer(orgId: string, customerId: string): Promise<void> {
	try {
		await ddb.send(
			new PutCommand({
				TableName: table(),
				Item: { ...customerKey(customerId), org_id: orgId },
				ConditionExpression: "attribute_not_exists(pk) OR org_id = :org",
				ExpressionAttributeValues: { ":org": orgId },
			}),
		);
	} catch (e) {
		// Names no ids: this text lands in CloudWatch.
		if ((e as { name?: string }).name === "ConditionalCheckFailedException") throw new Error("Stripe customer is already linked to a different org");
		throw e;
	}
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

// `expectedSubscriptionId` is for a deletion (sub null): it names the subscription that was deleted, so the
// write is refused if the org has since moved to a different one.
export async function applySubscription(
	orgId: string,
	sub: Stripe.Subscription | null,
	now = Date.now(),
	expectedSubscriptionId?: string,
): Promise<ApplyResult> {
	// One retry: the expected conflicts are a spend-cap change, or a newer subscription, landing between our read and write.
	for (let attempt = 0; ; attempt++) {
		const result = await tryApply(orgId, sub, now, attempt === 0, expectedSubscriptionId);
		if (result) return result;
	}
}

// Returns null when the spend cap changed under us and a fresh read may still succeed.
async function tryApply(orgId: string, sub: Stripe.Subscription | null, now: number, mayRetry: boolean, expectedSubscriptionId?: string): Promise<ApplyResult | null> {
	const [previous, profile] = await Promise.all([getBilling(orgId), getProfile(orgId)]);
	// A late event for an old subscription (say its final invoice after a cancel and resubscribe) is
	// re-fetched as canceled; applying it would downgrade the org's newer live subscription.
	if (previous?.subscription_id && sub && sub.id !== previous.subscription_id && LIVE.has(previous.status) && TERMINAL.has(sub.status)) {
		console.warn(`ignoring stale subscription for org ${orgId}: ${sub.id} (${sub.status}) while ${previous.subscription_id} is ${previous.status}`);
		return { plan: previous.plan, periodChanged: false, previous, applied: false };
	}
	// The same for a deletion event whose subscription is gone: applying "none" would drop the newer one's plan.
	const guardDeletion = !sub && !!expectedSubscriptionId;
	if (guardDeletion && previous?.subscription_id && previous.subscription_id !== expectedSubscriptionId) {
		console.warn(`ignoring deletion of superseded subscription for org ${orgId}: ${expectedSubscriptionId} while ${previous.subscription_id} is ${previous.status}`);
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

	// The period BILLING is leaving, owed a final report: on a rollover, or when a paid plan ends (the
	// hourly meter no longer scans a canceled org's usage). Written with the move so neither can happen alone.
	const periodChanged = !!previous?.current_period_start && previous.current_period_start !== periodStart;
	const paidToFree = !!previous && previous.plan !== "free" && plan === "free";
	const flushDue: FlushDue | null =
		(periodChanged || paidToFree) && previous?.current_period_start && previous.current_period_end
			? { period: previous.current_period_start.slice(0, 10), period_end: previous.current_period_end }
			: null;

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
				// A deletion also needs the org to still be on the subscription that was deleted.
				ConditionExpression:
					"(attribute_not_exists(spend_cap_usd) OR spend_cap_usd = :readCap)" +
					(guardDeletion
						? " AND (attribute_not_exists(subscription_id) OR attribute_type(subscription_id, :nullType) OR subscription_id = :expected)"
						: ""),
				// The cap and the meter's counters belong to other writers, so they are only initialised here.
				UpdateExpression:
					"SET customer_id = :cus, subscription_id = :sub, #s = :status, #p = :plan, current_period_start = :cps, current_period_end = :cpe, " +
					"cancel_at_period_end = :cancel, past_due_since = :pd, org_id = :org, " +
					"spend_cap_usd = if_not_exists(spend_cap_usd, :cap), reported_events = if_not_exists(reported_events, :zero), reported_period = if_not_exists(reported_period, :none)" +
					// An older period still owed keeps its place: the meter settles it first.
					(flushDue ? ", flush_due = if_not_exists(flush_due, :fd)" : ""),
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
					...(guardDeletion ? { ":nullType": "NULL", ":expected": expectedSubscriptionId } : {}),
					...(flushDue ? { ":fd": flushDue } : {}),
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
	return { plan, periodChanged, previous, applied: true };
}

// The console's spend cap: BILLING keeps the cap and PROFILE the monthly limit derived from it, written together
// so ingest never enforces a limit the cap no longer matches. Conditioned on the plan the caller read, so a
// downgrade that landed meanwhile isn't overwritten with a paid limit. False means a condition failed (the
// plan moved, or there is no BILLING item) and the caller should re-read.
export async function setSpendCap(orgId: string, plan: Exclude<PlanId, "free">, capUsd: number | null): Promise<boolean> {
	try {
		await ddb.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Update: {
							TableName: table(),
							Key: { pk: k.org(orgId), sk: "PROFILE" },
							ConditionExpression: "#s = :active AND #p = :plan",
							UpdateExpression: "SET limits.monthly_events = :events",
							ExpressionAttributeNames: { "#s": "status", "#p": "plan" },
							ExpressionAttributeValues: { ":active": "active", ":plan": plan, ":events": deriveMonthlyEvents(PLANS[plan], capUsd) },
						},
					},
					{
						Update: {
							TableName: table(),
							Key: billingKey(orgId),
							ConditionExpression: "attribute_exists(pk)",
							UpdateExpression: "SET spend_cap_usd = :cap",
							ExpressionAttributeValues: { ":cap": capUsd },
						},
					},
				],
			}),
		);
		return true;
	} catch (e) {
		if (conditionFailedAt(e, 0) || conditionFailedAt(e, 1)) return false;
		throw e;
	}
}

// Only the period that was reported is cleared: a newer flush_due written since must stay.
export async function clearFlushDue(orgId: string, period: string): Promise<void> {
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: table(),
				Key: billingKey(orgId),
				UpdateExpression: "REMOVE flush_due",
				ConditionExpression: "flush_due.#p = :p",
				ExpressionAttributeNames: { "#p": "period" },
				ExpressionAttributeValues: { ":p": period },
			}),
		);
	} catch (e) {
		// Already cleared by the other of webhook and meter.
		if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
	}
}

// A claim on an event expires, so a Lambda killed mid-processing doesn't lose the event: once the lease
// has lapsed the next delivery takes it over. Must outlast the webhook Lambda's timeout (60 s).
const LEASE_SECONDS = 90;

export type EventClaim = "claimed" | "done" | "in_progress";

// DynamoDB hands back the failed item as raw attribute values ({ S: "done" }); read either shape.
const scalar = (v: unknown): unknown => (v && typeof v === "object" ? ((v as { S?: string; N?: string }).S ?? (v as { N?: string }).N) : v);

// "claimed": this delivery owns the event. "done": already handled, so a duplicate. "in_progress": another
// delivery holds a live lease; the caller must not answer 200, because if that one dies nobody else would run it.
export async function recordEventOnce(eventId: string, type: string, now = Date.now()): Promise<EventClaim> {
	const nowSeconds = Math.floor(now / 1000);
	try {
		await ddb.send(
			new PutCommand({
				TableName: table(),
				Item: {
					...eventKey(eventId),
					type,
					status: "processing",
					lease_until: nowSeconds + LEASE_SECONDS,
					received_at: new Date(now).toISOString(),
					expires_at: nowSeconds + EVENT_TTL_SECONDS,
				},
				// A finished event, or one whose lease is still live, is not ours; an expired lease is taken over.
				ConditionExpression: "attribute_not_exists(pk) OR (#st = :processing AND lease_until < :now)",
				ExpressionAttributeNames: { "#st": "status" },
				ExpressionAttributeValues: { ":processing": "processing", ":now": nowSeconds },
				ReturnValuesOnConditionCheckFailure: "ALL_OLD",
			}),
		);
		return "claimed";
	} catch (e) {
		const err = e as { name?: string; Item?: Record<string, unknown> };
		if (err.name !== "ConditionalCheckFailedException") throw e;
		// The condition only fails for a live lease or a finished record. A record from before leases has no
		// status and is finished. With no item to read, assume the worse case (in progress): Stripe just retries.
		if (!err.Item) return "in_progress";
		return scalar(err.Item.status) === "processing" ? "in_progress" : "done";
	}
}

// After the event's effects are written, so any later delivery of it is a duplicate for good.
export async function completeEvent(eventId: string): Promise<void> {
	await ddb.send(
		new UpdateCommand({
			TableName: table(),
			Key: eventKey(eventId),
			UpdateExpression: "SET #st = :done REMOVE lease_until",
			ConditionExpression: "attribute_exists(pk)",
			ExpressionAttributeNames: { "#st": "status" },
			ExpressionAttributeValues: { ":done": "done" },
		}),
	);
}

// Lets Stripe's retry reprocess an event whose handling failed after it was recorded.
export async function forgetEvent(eventId: string): Promise<void> {
	await ddb.send(new DeleteCommand({ TableName: table(), Key: eventKey(eventId) }));
}
