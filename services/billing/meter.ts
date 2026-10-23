import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { k } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { counterIds, readCounter } from "../shared/tenants";
import { getStripe } from "./stripe";
import type { BillingRecord } from "./subscriptions";

export const METER_EVENT_NAME = "tracewise_events";

// BILLING stores the period as a full ISO instant but PROFILE (and so ingest's counter key) holds
// the date; reading with anything else would find an empty counter and report nothing.
export const periodKey = (iso: string) => iso.slice(0, 10);

// Reports the events counted since the last report for `periodStart`. `timestamp` is epoch seconds
// (Stripe's unit) and must fall inside the period being reported, which the rollover flush relies on.
export async function reportOrgUsage(
	billing: BillingRecord,
	opts: { periodStart: string; timestamp: number },
): Promise<{ sent: number }> {
	const periodStart = periodKey(opts.periodStart);
	// reported_period only moves forward (through the rollover path, after it flushed the old period),
	// so an older period is already final: resending it under a new identifier would bill it twice.
	if (billing.reported_period && periodStart < periodKey(billing.reported_period)) return { sent: 0 };
	const counter = await readCounter(counterIds.period(billing.org_id, periodStart));
	// reported_events belongs to whichever period was reported last; another period starts over.
	const base = billing.reported_period === periodStart ? billing.reported_events : 0;
	const delta = counter - base;
	if (delta <= 0) return { sent: 0 };

	const stripe = await getStripe();
	await stripe.billing.meterEvents.create({
		event_name: METER_EVENT_NAME,
		payload: { stripe_customer_id: billing.customer_id, value: String(delta) },
		// Same counter, same identifier: a retry after a failed bookkeeping write is deduplicated by Stripe.
		identifier: `${billing.org_id}:${periodStart}:${counter}`,
		timestamp: opts.timestamp,
	});

	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				Key: { pk: k.org(billing.org_id), sk: "BILLING" },
				UpdateExpression: "SET reported_events = :counter, reported_period = :p",
				// Only move forward from what we read: a concurrent run that already reported wins.
				ConditionExpression: "(reported_period = :p AND reported_events = :old) OR attribute_not_exists(reported_period) OR reported_period <> :p",
				ExpressionAttributeValues: { ":counter": counter, ":p": periodStart, ":old": billing.reported_events },
			}),
		);
	} catch (e) {
		// Another run reported this period between our read and write; its identifier covers the same events.
		if ((e as { name?: string }).name === "ConditionalCheckFailedException") return { sent: 0 };
		throw e;
	}
	return { sent: delta };
}
