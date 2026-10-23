import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import { ddb } from "../shared/ddb";
import { log } from "../shared/http";
import { periodBounds } from "./plans";
import { periodKey, reportOrgUsage } from "./meter";
import { getStripe } from "./stripe";
import { applySubscription, getBilling, type BillingRecord } from "./subscriptions";

const cloudwatch = new CloudWatchClient({});
const CONCURRENCY = 5;
// Matches the grace in effectivePlan; past that, the org is owed Free limits.
const GRACE_MS = 7 * 86_400_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function liveBilling(): Promise<BillingRecord[]> {
	const items: BillingRecord[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(
			new ScanCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				FilterExpression: "sk = :b AND #s IN (:active, :trialing, :pastDue)",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":b": "BILLING", ":active": "active", ":trialing": "trialing", ":pastDue": "past_due" },
				ExclusiveStartKey: startKey,
			}),
		);
		for (const item of page.Items ?? []) items.push(item as BillingRecord);
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return items;
}

// Runs `fn` over `items`, at most `limit` at a time. Failures are collected, never thrown, so one
// org can't stop the others.
async function forEachBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) await fn(items[i] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// The same period ingest counts into: the profile's dates come from these, and a paid org without
// them (or one already downgraded to Free) uses the calendar month.
function periodOf(billing: BillingRecord): string {
	return periodBounds({
		plan: billing.plan,
		period_start: billing.current_period_start?.slice(0, 10),
		period_end: billing.current_period_end?.slice(0, 10),
	}).start;
}

// Past-due grace expiry would otherwise wait for Stripe's next event for the subscription.
// Returns how many orgs could not be re-applied, so the caller can count them as failures.
async function expireGrace(billings: BillingRecord[], now: number): Promise<number> {
	const due = billings.filter(
		(b) => b.status === "past_due" && b.plan !== "free" && !!b.past_due_since && now - Date.parse(b.past_due_since) > GRACE_MS,
	);
	if (due.length === 0) return 0;
	let failed = 0;
	let stripe: Stripe;
	try {
		stripe = await getStripe();
	} catch (e) {
		log("error", "could not re-apply past-due subscriptions", { orgs: due.length, error: message(e) });
		return due.length;
	}
	await forEachBounded(due, CONCURRENCY, async (b) => {
		try {
			let sub: Stripe.Subscription | null = null;
			if (b.subscription_id) {
				try {
					sub = await stripe.subscriptions.retrieve(b.subscription_id);
				} catch (e) {
					if ((e as { statusCode?: number }).statusCode !== 404) throw e;
				}
			}
			const result = await applySubscription(b.org_id, sub, now);
			log("info", "re-applied past-due subscription", { org_id: b.org_id, plan: result.plan, applied: result.applied });
		} catch (e) {
			failed++;
			log("error", "could not re-apply past-due subscription", { org_id: b.org_id, error: message(e) });
		}
	});
	return failed;
}

const startSeconds = (b: BillingRecord, period: string) =>
	// Stripe's real instant when BILLING has one for this period; midnight UTC of the date otherwise.
	Math.floor(Date.parse(b.current_period_start && periodKey(b.current_period_start) === period ? b.current_period_start : `${period}T00:00:00Z`) / 1000);

// Moving to a new period first flushes what is left of the old one, because the counters
// (reported_events, reported_period) only describe one period and would otherwise forget it.
async function meterOrg(b: BillingRecord, periodStart: string, now: number): Promise<number> {
	let view = b;
	const reportedPeriod = b.reported_period ? periodKey(b.reported_period) : null;
	if (reportedPeriod && reportedPeriod < periodStart) {
		await reportOrgUsage(b, { periodStart: reportedPeriod, timestamp: startSeconds(b, periodStart) - 1 });
		// Pick up whatever the flush (or a concurrent run) recorded rather than trusting the scan's copy.
		view = (await getBilling(b.org_id)) ?? b;
	}
	return (await reportOrgUsage(view, { periodStart, timestamp: Math.floor(now / 1000) })).sent;
}

export async function handler(): Promise<void> {
	const now = Date.now();
	const billings = await liveBilling();
	let reported = 0;
	let meterFailures = 0;

	await forEachBounded(billings, CONCURRENCY, async (b) => {
		const periodStart = periodOf(b);
		try {
			const sent = await meterOrg(b, periodStart, now);
			if (sent > 0) reported++;
			log("info", "metered org", { org_id: b.org_id, period: periodStart, delta: sent });
		} catch (e) {
			meterFailures++;
			log("error", "metering failed", { org_id: b.org_id, period: periodStart, error: message(e) });
		}
	});

	// Grace re-apply failures count too, so the one alarm covers them.
	let failures = meterFailures;
	try {
		failures += await expireGrace(billings, now);
	} catch (e) {
		failures++;
		log("error", "past-due re-apply failed", { error: message(e) });
	}

	// A gauge that counted up would need its own timer, so the alarm watches for this datapoint going missing instead.
	const metrics = [
		{ MetricName: "MeterOrgsReported", Value: reported, Unit: "Count" as const },
		{ MetricName: "MeterFailures", Value: failures, Unit: "Count" as const },
		...(failures === 0 ? [{ MetricName: "MeterLastSuccessAgeMinutes", Value: 0, Unit: "None" as const }] : []),
	];
	try {
		await cloudwatch.send(new PutMetricDataCommand({ Namespace: "Tracewise/Billing", MetricData: metrics }));
	} catch (e) {
		// Best effort: a CloudWatch blip mustn't fail metering that already succeeded.
		log("warn", "could not publish meter metrics", { error: message(e) });
	}

	if (billings.length > 0 && meterFailures === billings.length) throw new Error(`metering failed for all ${meterFailures} orgs`);
}
