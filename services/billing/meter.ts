import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { k } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { counterIds, readCounter } from "../shared/tenants";
import { getStripe } from "./stripe";
import type { BillingRecord, PendingMeterEvent } from "./subscriptions";

export const METER_EVENT_NAME = "tracewise_events";

// BILLING stores the period as a full ISO instant but PROFILE (and so ingest's counter key) holds
// the date; reading with anything else would find an empty counter and report nothing. Every
// period comparison goes through this so both sides are always dates.
export const periodKey = (iso: string) => iso.slice(0, 10);

// The timestamp for an event that belongs to a period: inside it (end - 1 s), but never in the future, because
// Stripe rejects meter events dated ahead and a period can end later than now. Epoch seconds in and out.
export function clampTimestamp(nowSec: number, periodEndIso?: string | null): number {
	const end = periodEndIso ? Date.parse(periodEndIso) / 1000 : NaN;
	return Math.floor(Number.isFinite(end) ? Math.min(nowSec, end - 1) : nowSec);
}

const isConditionFailure = (e: unknown) => (e as { name?: string }).name === "ConditionalCheckFailedException";

// Stripe refuses a meter event whose identifier it has already accepted. That means an earlier
// attempt landed, which is the outcome we wanted. Matched narrowly: anything else is a real failure
// and the claim stays pending for the next run.
export function isDuplicateIdentifier(e: unknown): boolean {
	const err = e as { type?: string; code?: string; statusCode?: number; message?: string };
	if (err.code === "resource_already_exists") return true;
	return (
		err.type === "StripeInvalidRequestError" &&
		err.statusCode === 400 &&
		/identifier/i.test(err.message ?? "") &&
		/(already|duplicate|exists|unique)/i.test(err.message ?? "")
	);
}

const billingKey = (orgId: string) => ({ pk: k.org(orgId), sk: "BILLING" });

async function sendEvent(billing: BillingRecord, event: PendingMeterEvent): Promise<void> {
	const stripe = await getStripe();
	try {
		await stripe.billing.meterEvents.create({
			event_name: METER_EVENT_NAME,
			payload: { stripe_customer_id: billing.customer_id, value: event.value },
			identifier: event.identifier,
			timestamp: event.timestamp,
		});
	} catch (e) {
		if (!isDuplicateIdentifier(e)) throw e;
	}
}

// Only the run that claimed the event clears it; a run that lost the claim never gets here.
async function clearPending(orgId: string, identifier: string): Promise<void> {
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				Key: billingKey(orgId),
				UpdateExpression: "REMOVE #pend",
				ConditionExpression: "#pend.identifier = :id",
				ExpressionAttributeNames: { "#pend": "pending" },
				ExpressionAttributeValues: { ":id": identifier },
			}),
		);
	} catch (e) {
		// Already cleared by a run that re-sent it too.
		if (!isConditionFailure(e)) throw e;
	}
}

// Reports the events counted since the last report for `periodStart`. `timestamp` is epoch seconds
// (Stripe's unit) and must fall inside the period being reported, which the rollover flush relies on.
//
// Claim, then send: BILLING is advanced (with the event recorded as `pending`) before Stripe is
// called, so only the run that won the write sends, and a failed send leaves the exact event to
// re-send. Sending first would double-bill whenever the write failed and the counter then moved.
export async function reportOrgUsage(
	billing: BillingRecord,
	opts: { periodStart: string; timestamp: number },
): Promise<{ sent: number }> {
	const periodStart = periodKey(opts.periodStart);
	let sent = 0;
	let view = billing;

	// An earlier run claimed an event and never confirmed it. Stripe dedupes on the identifier,
	// so re-sending exactly that event is safe and must come before any new delta.
	if (billing.pending) {
		await sendEvent(billing, billing.pending);
		await clearPending(billing.org_id, billing.pending.identifier);
		sent += Number(billing.pending.value);
		const { pending: _pending, ...rest } = billing;
		view = rest;
	}

	const reportedPeriod = view.reported_period ? periodKey(view.reported_period) : null;
	// reported_period only moves forward (through the rollover path, after it flushed the old period),
	// so an older period is already final: reporting it again would bill it twice.
	if (reportedPeriod && periodStart < reportedPeriod) return { sent };

	// Only paid usage is billed, so the meter reads the paid counter whatever plan the org is on now.
	const counter = await readCounter(counterIds.period(view.org_id, periodStart, true));
	// reported_events belongs to whichever period was reported last; another period starts over.
	const base = reportedPeriod === periodStart ? view.reported_events : 0;
	const delta = counter - base;
	if (delta <= 0) return { sent };

	const event: PendingMeterEvent = {
		identifier: `${view.org_id}:${periodStart}:${counter}`,
		value: String(delta),
		timestamp: opts.timestamp,
		period: periodStart,
	};
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				Key: billingKey(view.org_id),
				UpdateExpression: "SET reported_events = :counter, reported_period = :p, #pend = :event",
				// Forward-only from what we read, with nothing already pending: a stale or overlapping
				// writer is refused here, before it can call Stripe. Dates compare lexically.
				ConditionExpression:
					"attribute_exists(pk) AND attribute_not_exists(#pend) AND (attribute_not_exists(reported_period) OR attribute_type(reported_period, :nullType) OR " +
					"(reported_period = :p AND reported_events = :old) OR reported_period < :p)",
				ExpressionAttributeNames: { "#pend": "pending" },
				ExpressionAttributeValues: { ":counter": counter, ":p": periodStart, ":old": view.reported_events, ":event": event, ":nullType": "NULL" },
			}),
		);
	} catch (e) {
		// Another run (or a newer period) got there first: it owns these events, and Stripe is not called.
		if (isConditionFailure(e)) return { sent };
		throw e;
	}

	await sendEvent(view, event);
	await clearPending(view.org_id, event.identifier);
	return { sent: sent + delta };
}
