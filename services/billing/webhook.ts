import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type Stripe from "stripe";
import { json, log } from "../shared/http";
import { clampTimestamp, reportOrgUsage } from "./meter";
import { getStripe, getWebhookSecret } from "./stripe";
import { applySubscription, clearFlushDue, completeEvent, forgetEvent, getBilling, linkCustomer, orgForCustomer, recordEventOnce } from "./subscriptions";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : (x?.id ?? null));

// A subscription Stripe no longer has is treated as deleted (null) by the caller that allows it.
async function fetchSubscription(stripe: Stripe, id: string, missingIsDeleted: boolean): Promise<Stripe.Subscription | null> {
	try {
		return await stripe.subscriptions.retrieve(id);
	} catch (e) {
		if (missingIsDeleted && (e as { statusCode?: number }).statusCode === 404) return null;
		throw e;
	}
}

// Newer API versions nest the link under parent.subscription_details; older ones had invoice.subscription.
function invoiceSubscription(invoice: Stripe.Invoice): { id: string | null; orgId: string | null } {
	const legacy = invoice as unknown as { subscription?: string | { id: string } | null };
	const details = invoice.parent?.subscription_details;
	return { id: idOf(details?.subscription) ?? idOf(legacy.subscription), orgId: details?.metadata?.org_id ?? null };
}

// applySubscription records the period it just left as `flush_due` in the same write as the move, so
// this does not depend on this delivery's result: a retry after a failed flush finds it still there.
// The old period's counter no longer changes once BILLING has moved on, so reporting it now is safe.
async function settleFlushDue(orgId: string, now: number): Promise<void> {
	// The current record, not the pre-apply one, so the meter's finalised-period guard and claim condition see today's state.
	const current = await getBilling(orgId);
	const due = current?.flush_due;
	if (!current || !due) return;
	const timestamp = clampTimestamp(now / 1000, due.period_end);
	const { sent } = await reportOrgUsage(current, { periodStart: due.period, timestamp });
	// sent: 0 also covers a refused claim or a pending left to the hourly meter; either way this period is
	// no longer ours to report, so it is not an error and the marker can go.
	await clearFlushDue(orgId, due.period);
	log("info", "flushed previous period", { org_id: orgId, period: due.period, sent });
}

async function applyAndFlush(orgId: string, sub: Stripe.Subscription | null, now: number, deletedId?: string): Promise<void> {
	const result = await applySubscription(orgId, sub, now, deletedId);
	if (result.applied) await settleFlushDue(orgId, now);
}

async function resolveOrg(metadataOrg: string | null | undefined, customerId: string | null): Promise<string | null> {
	return metadataOrg || (customerId ? await orgForCustomer(customerId) : null);
}

// Returns the org the event was applied to (null when it named none we know), for the log line.
async function dispatch(stripe: Stripe, event: Stripe.Event, now: number): Promise<string | null> {
	switch (event.type) {
		case "checkout.session.completed": {
			const session = event.data.object;
			const customerId = idOf(session.customer);
			const subId = idOf(session.subscription);
			// A one-off payment session carries no subscription; the link below is all there is to do.
			const fresh = subId ? await fetchSubscription(stripe, subId, false) : null;
			// Stripe's own copy of the subscription is authoritative over the session's reference, which the client supplies.
			const subOrg = fresh?.metadata?.org_id || null;
			if (subOrg && session.client_reference_id && subOrg !== session.client_reference_id) {
				log("warn", "checkout org does not match its subscription's org", { event_id: event.id, type: event.type, org_id: subOrg });
				throw new Error("checkout session and subscription name different orgs");
			}
			const orgId = subOrg || session.client_reference_id;
			if (!orgId || !customerId) return null;
			await linkCustomer(orgId, customerId);
			if (fresh) await applyAndFlush(orgId, fresh, now);
			return orgId;
		}
		case "customer.subscription.created":
		case "customer.subscription.updated":
		case "customer.subscription.deleted": {
			const evSub = event.data.object;
			const orgId = await resolveOrg(evSub.metadata?.org_id, idOf(evSub.customer));
			if (!orgId) return null;
			// The event body may be stale or out of order; Stripe's current state is what counts.
			// Only a deletion may read "Stripe has no such subscription" as "none": for any other event it is an error,
			// or a delayed or odd answer would downgrade a plan that is still paid for.
			const deleted = event.type === "customer.subscription.deleted";
			const fresh = await fetchSubscription(stripe, evSub.id, deleted);
			// A deletion is refused if the org has moved to a newer subscription (checked inside the write).
			await applyAndFlush(orgId, fresh, now, deleted && !fresh ? evSub.id : undefined);
			return orgId;
		}
		case "invoice.paid":
		case "invoice.payment_failed": {
			const invoice = event.data.object;
			const { id: subId, orgId: metadataOrg } = invoiceSubscription(invoice);
			// Not a subscription invoice, so nothing here concerns a plan.
			if (!subId) return null;
			const orgId = await resolveOrg(metadataOrg, idOf(invoice.customer));
			if (!orgId) return null;
			await applyAndFlush(orgId, await fetchSubscription(stripe, subId, false), now);
			return orgId;
		}
		default:
			return null;
	}
}

const HANDLED = new Set([
	"checkout.session.completed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"invoice.paid",
	"invoice.payment_failed",
]);

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	// The signature covers the exact bytes Stripe sent, so decode rather than re-serialise.
	const body = event.body ?? "";
	const raw = event.isBase64Encoded ? Buffer.from(body, "base64") : body;

	let stripe: Stripe;
	let stripeEvent: Stripe.Event;
	try {
		stripe = await getStripe();
		const secret = await getWebhookSecret();
		try {
			stripeEvent = stripe.webhooks.constructEvent(raw, event.headers?.["stripe-signature"] ?? "", secret);
		} catch {
			// Never log the header or body: they are attacker-controlled and the header is a secret-derived value.
			log("warn", "stripe webhook signature rejected");
			return json(400, { error: "bad signature" });
		}
	} catch (e) {
		// No secret to verify with: Stripe should retry once that is fixed.
		log("error", "stripe webhook could not be verified", { error: message(e) });
		return json(500, { error: "webhook error" });
	}

	const { id, type } = stripeEvent;
	// Nothing to do for these, so they cost no write.
	if (!HANDLED.has(type)) return json(200, { ok: true });
	let recorded = false;
	try {
		const claim = await recordEventOnce(id, type, Date.now());
		if (claim === "done") {
			log("info", "stripe event already processed", { event_id: id, type });
			return json(200, { ok: true, duplicate: true });
		}
		if (claim === "in_progress") {
			// Not ours to un-record. A 200 here would lose the event if the delivery holding the lease dies.
			log("info", "stripe event is being processed elsewhere", { event_id: id, type });
			return json(409, { error: "event in progress, retry later" });
		}
		recorded = true;
		const orgId = await dispatch(stripe, stripeEvent, Date.now());
		if (orgId) log("info", "stripe event handled", { event_id: id, type, org_id: orgId });
		// Answering 200 stops Stripe retrying an event that can never find its org.
		else log("warn", "stripe event not applied: no known org or no subscription", { event_id: id, type });
		try {
			await completeEvent(id);
		} catch (e) {
			// The work is done and every step is idempotent: the lease just lapses, which is harmless.
			log("error", "could not mark stripe event done", { event_id: id, type, org_id: orgId ?? undefined, error: message(e) });
		}
		return json(200, { ok: true });
	} catch (e) {
		log("error", "stripe event failed", { event_id: id, type, error: message(e) });
		// Un-record it so Stripe's retry is processed instead of dismissed as a duplicate.
		if (recorded) {
			try {
				await forgetEvent(id);
			} catch (f) {
				log("error", "could not forget stripe event", { event_id: id, error: message(f) });
			}
		}
		return json(500, { error: "webhook error" });
	}
}
