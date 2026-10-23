import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/shared/ddb", () => ({ ddb: { send: vi.fn() } }));
const retrieve = vi.hoisted(() => vi.fn());
// A real Stripe instance only for `.webhooks` (signature checks are local); API calls are stubbed.
const real = new Stripe("sk_test_x");
const stripe = { webhooks: real.webhooks, subscriptions: { retrieve } };
const SECRET = "whsec_test";
vi.mock("../services/billing/stripe", () => ({ getStripe: async () => stripe, getWebhookSecret: async () => SECRET }));
const subs = vi.hoisted(() => ({
	applySubscription: vi.fn(),
	orgForCustomer: vi.fn(),
	linkCustomer: vi.fn(),
	recordEventOnce: vi.fn(),
	forgetEvent: vi.fn(),
	getBilling: vi.fn(),
	clearFlushDue: vi.fn(),
}));
vi.mock("../services/billing/subscriptions", () => subs);
const meter = vi.hoisted(() => ({ reportOrgUsage: vi.fn() }));
vi.mock("../services/billing/meter", async (orig) => ({ ...(await orig<object>()), ...meter }));

const { handler } = await import("../services/billing/webhook");

const NOW = Date.parse("2026-10-23T12:00:00Z");

function signed(payload: string, over: { secret?: string; timestamp?: number } = {}) {
	return real.webhooks.generateTestHeaderString({ payload, secret: over.secret ?? SECRET, ...(over.timestamp ? { timestamp: over.timestamp } : {}) });
}
const evt = (type: string, object: object, id = "evt_1") => JSON.stringify({ id, object: "event", type, data: { object } });
function call(payload: string, opts: { header?: string; base64?: boolean; send?: string } = {}) {
	const body = opts.send ?? payload;
	return handler({
		body: opts.base64 ? Buffer.from(body).toString("base64") : body,
		isBase64Encoded: !!opts.base64,
		headers: { "stripe-signature": opts.header ?? signed(payload) },
	} as never);
}

const sub = (over: object = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: {}, items: { data: [] }, ...over });
const apply = (over: object = {}) => ({ plan: "team", applied: true, periodChanged: false, previous: null, ...over });
const due = (over: object = {}) => ({ period: "2026-09-15", period_end: "2026-10-15T00:00:00Z", ...over });

// Per test: nothing from a previous test may leak through a mock that was configured once.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const m of [retrieve, meter.reportOrgUsage, ...Object.values(subs)]) m.mockReset();
	subs.recordEventOnce.mockResolvedValue(true);
	subs.orgForCustomer.mockResolvedValue("o1");
	subs.applySubscription.mockResolvedValue(apply());
	subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team" });
	meter.reportOrgUsage.mockResolvedValue({ sent: 7 });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("signature", () => {
	it("accepts a correctly signed body, raw or base64, verified on the exact bytes", async () => {
		// Odd spacing and non-ASCII: re-serialising the parsed JSON would change these bytes.
		const payload = `{ "id" : "evt_1",  "object":"event", "type":"ping.unknown", "data":{"object":{"name":"Zoë  ✓"}} }`;
		const spy = vi.spyOn(real.webhooks, "constructEvent");
		expect((await call(payload)).statusCode).toBe(200);
		expect((await call(payload, { base64: true })).statusCode).toBe(200);
		expect(spy.mock.calls[0]![0]).toBe(payload);
		const second = spy.mock.calls[1]![0];
		expect(Buffer.isBuffer(second) && second.equals(Buffer.from(payload))).toBe(true);
	});

	it.each([
		["tampered body", (p: string) => ({ send: p.replace("evt_1", "evt_2") })],
		["wrong secret", (p: string) => ({ header: signed(p, { secret: "whsec_other" }) })],
		["stale timestamp", (p: string) => ({ header: signed(p, { timestamp: Math.floor(NOW / 1000) - 3600 }) })],
		["missing signature", () => ({ header: "" })],
	])("rejects a %s", async (_name, make) => {
		const payload = evt("customer.subscription.updated", sub());
		const res = await call(payload, make(payload));
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body as string)).toEqual({ error: "bad signature" });
		expect(subs.recordEventOnce).not.toHaveBeenCalled();
		expect(subs.applySubscription).not.toHaveBeenCalled();
		expect(retrieve).not.toHaveBeenCalled();
	});
});

describe("idempotency and errors", () => {
	it("ignores a replayed event", async () => {
		subs.recordEventOnce.mockResolvedValue(false);
		const res = await call(evt("customer.subscription.updated", sub()));
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body as string)).toEqual({ ok: true, duplicate: true });
		expect(retrieve).not.toHaveBeenCalled();
		expect(subs.applySubscription).not.toHaveBeenCalled();
	});

	it("lets Stripe retry after an unexpected error", async () => {
		retrieve.mockResolvedValue(sub());
		subs.applySubscription.mockRejectedValue(new Error("ddb down"));
		const res = await call(evt("customer.subscription.updated", sub()));
		expect(res.statusCode).toBe(500);
		expect(subs.forgetEvent).toHaveBeenCalledWith("evt_1");
	});

	it("still answers 500 when forgetting the event also fails", async () => {
		retrieve.mockResolvedValue(sub());
		subs.applySubscription.mockRejectedValue(new Error("ddb down"));
		subs.forgetEvent.mockRejectedValue(new Error("still down"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect((await call(evt("customer.subscription.updated", sub()))).statusCode).toBe(500);
	});

	it("does not forget an event it never recorded", async () => {
		subs.recordEventOnce.mockRejectedValue(new Error("ddb down"));
		expect((await call(evt("customer.subscription.updated", sub()))).statusCode).toBe(500);
		expect(subs.forgetEvent).not.toHaveBeenCalled();
	});

	it("treats an unknown customer as handled", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		subs.orgForCustomer.mockResolvedValue(null);
		const res = await call(evt("customer.subscription.updated", sub()));
		expect(res.statusCode).toBe(200);
		expect(subs.applySubscription).not.toHaveBeenCalled();
		expect(subs.forgetEvent).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]![0])).toContain("evt_1");
	});

	it("answers 200 for event types it does not handle, without calling Stripe", async () => {
		const res = await call(evt("customer.created", { id: "cus_1" }));
		expect(res.statusCode).toBe(200);
		expect(retrieve).not.toHaveBeenCalled();
		expect(subs.applySubscription).not.toHaveBeenCalled();
	});

	it("logs only the event id, type and org id", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		retrieve.mockResolvedValue(sub());
		await call(evt("customer.subscription.updated", sub({ metadata: { org_id: "o1" } })));
		const fields = info.mock.calls.map(([l]) => JSON.parse(String(l))).find((l) => l.msg === "stripe event handled");
		expect(Object.keys(fields).sort()).toEqual(["event_id", "level", "msg", "org_id", "type"]);
	});
});

describe("checkout.session.completed", () => {
	it("links the customer and applies the plan", async () => {
		const fresh = sub();
		retrieve.mockResolvedValue(fresh);
		const res = await call(evt("checkout.session.completed", { client_reference_id: "o1", customer: "cus_1", subscription: "sub_1" }));
		expect(res.statusCode).toBe(200);
		expect(subs.linkCustomer).toHaveBeenCalledWith("o1", "cus_1");
		expect(retrieve).toHaveBeenCalledWith("sub_1");
		expect(subs.applySubscription).toHaveBeenCalledWith("o1", fresh, NOW);
	});

	it("accepts expanded customer and subscription objects", async () => {
		retrieve.mockResolvedValue(sub());
		await call(evt("checkout.session.completed", { client_reference_id: "o1", customer: { id: "cus_1" }, subscription: { id: "sub_1" } }));
		expect(subs.linkCustomer).toHaveBeenCalledWith("o1", "cus_1");
		expect(retrieve).toHaveBeenCalledWith("sub_1");
	});

	it("handles a session with no org as unknown", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await call(evt("checkout.session.completed", { client_reference_id: null, customer: "cus_1", subscription: "sub_1" }));
		expect(res.statusCode).toBe(200);
		expect(subs.linkCustomer).not.toHaveBeenCalled();
		expect(subs.applySubscription).not.toHaveBeenCalled();
	});

	it("retries when the new subscription cannot be fetched", async () => {
		retrieve.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 404 }));
		const res = await call(evt("checkout.session.completed", { client_reference_id: "o1", customer: "cus_1", subscription: "sub_1" }));
		expect(res.statusCode).toBe(500);
		expect(subs.forgetEvent).toHaveBeenCalledWith("evt_1");
	});
});

describe("subscription events", () => {
	it("re-fetches instead of trusting the event, so a stale update can't revive a canceled plan", async () => {
		const canceled = sub({ status: "canceled" });
		retrieve.mockResolvedValue(canceled);
		await call(evt("customer.subscription.updated", sub({ status: "active", metadata: { org_id: "o1" } })));
		expect(subs.applySubscription).toHaveBeenCalledWith("o1", canceled, NOW);
	});

	it("takes the org from metadata without a customer lookup, else from the customer", async () => {
		retrieve.mockResolvedValue(sub());
		await call(evt("customer.subscription.created", sub({ metadata: { org_id: "o9" } })));
		expect(subs.orgForCustomer).not.toHaveBeenCalled();
		expect(subs.applySubscription).toHaveBeenLastCalledWith("o9", expect.anything(), NOW);
		await call(evt("customer.subscription.updated", sub(), "evt_2"));
		expect(subs.orgForCustomer).toHaveBeenCalledWith("cus_1");
		expect(subs.applySubscription).toHaveBeenLastCalledWith("o1", expect.anything(), NOW);
	});

	it("applies a deleted subscription Stripe no longer has as null", async () => {
		retrieve.mockRejectedValue(Object.assign(new Error("No such subscription"), { statusCode: 404 }));
		const res = await call(evt("customer.subscription.deleted", sub()));
		expect(res.statusCode).toBe(200);
		expect(subs.applySubscription).toHaveBeenCalledWith("o1", null, NOW);
	});

	it("retries on any other Stripe error", async () => {
		retrieve.mockRejectedValue(Object.assign(new Error("rate limited"), { statusCode: 429 }));
		expect((await call(evt("customer.subscription.updated", sub()))).statusCode).toBe(500);
		expect(subs.applySubscription).not.toHaveBeenCalled();
	});
});

describe("invoice events", () => {
	const shapes: [string, object][] = [
		["parent.subscription_details (id)", { customer: "cus_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } } }],
		["parent.subscription_details (expanded)", { customer: "cus_1", parent: { type: "subscription_details", subscription_details: { subscription: { id: "sub_1" } } } }],
		["legacy invoice.subscription", { customer: "cus_1", subscription: "sub_1" }],
	];
	it.each(shapes)("re-fetches the subscription from %s", async (_n, invoice) => {
		for (const type of ["invoice.paid", "invoice.payment_failed"]) {
			const fresh = sub({ status: "past_due" });
			retrieve.mockResolvedValue(fresh);
			subs.applySubscription.mockClear();
			const res = await call(evt(type, invoice));
			expect(res.statusCode).toBe(200);
			expect(retrieve).toHaveBeenLastCalledWith("sub_1");
			expect(subs.applySubscription).toHaveBeenCalledWith("o1", fresh, NOW);
			subs.recordEventOnce.mockResolvedValue(true);
		}
	});

	it("prefers the org in the invoice's subscription metadata", async () => {
		retrieve.mockResolvedValue(sub());
		await call(evt("invoice.paid", { customer: "cus_1", parent: { subscription_details: { subscription: "sub_1", metadata: { org_id: "o7" } } } }));
		expect(subs.applySubscription).toHaveBeenCalledWith("o7", expect.anything(), NOW);
	});

	it("ignores an invoice with no subscription", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await call(evt("invoice.paid", { customer: "cus_1", parent: null }));
		expect(res.statusCode).toBe(200);
		expect(retrieve).not.toHaveBeenCalled();
		expect(subs.applySubscription).not.toHaveBeenCalled();
	});
});

describe("flushing the previous period", () => {
	const run = () => {
		retrieve.mockResolvedValue(sub());
		return call(evt("customer.subscription.updated", sub({ metadata: { org_id: "o1" } })));
	};

	it("flushes the period applySubscription left due, after applying and before answering, then clears it", async () => {
		const order: string[] = [];
		const current = { org_id: "o1", plan: "team", reported_period: "2026-09-15", flush_due: due() };
		subs.applySubscription.mockImplementation(async () => (order.push("apply"), apply({ periodChanged: true })));
		subs.getBilling.mockImplementation(async () => (order.push("getBilling"), current));
		meter.reportOrgUsage.mockImplementation(async () => (order.push("report"), { sent: 3 }));
		subs.clearFlushDue.mockImplementation(async () => void order.push("clear"));
		const res = await run();
		expect(res.statusCode).toBe(200);
		expect(order).toEqual(["apply", "getBilling", "report", "clear"]);
		// The freshly read record, not anything from before the apply.
		expect(meter.reportOrgUsage).toHaveBeenCalledWith(current, {
			periodStart: "2026-09-15",
			timestamp: Date.parse("2026-10-15T00:00:00Z") / 1000 - 1,
		});
		expect(subs.clearFlushDue).toHaveBeenCalledWith("o1", "2026-09-15");
	});

	it("stamps a flush for a period that has not ended with now, never the future", async () => {
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "free", flush_due: due({ period_end: "2026-11-15T00:00:00Z" }) });
		await run();
		expect(meter.reportOrgUsage).toHaveBeenCalledWith(expect.anything(), { periodStart: "2026-09-15", timestamp: NOW / 1000 });
	});

	it("does nothing when nothing is due or the apply wrote nothing", async () => {
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team" });
		await run();
		subs.recordEventOnce.mockResolvedValue(true);
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team", flush_due: due() });
		subs.applySubscription.mockResolvedValue(apply({ applied: false }));
		await run();
		expect(meter.reportOrgUsage).not.toHaveBeenCalled();
		expect(subs.clearFlushDue).not.toHaveBeenCalled();
	});

	it("accepts { sent: 0 } as handled and clears the marker", async () => {
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team", flush_due: due() });
		meter.reportOrgUsage.mockResolvedValue({ sent: 0 });
		const res = await run();
		expect(res.statusCode).toBe(200);
		expect(subs.clearFlushDue).toHaveBeenCalledWith("o1", "2026-09-15");
		expect(subs.forgetEvent).not.toHaveBeenCalled();
	});

	it("keeps flush_due and lets Stripe retry when the flush fails", async () => {
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team", flush_due: due() });
		meter.reportOrgUsage.mockRejectedValue(new Error("stripe down"));
		expect((await run()).statusCode).toBe(500);
		expect(subs.clearFlushDue).not.toHaveBeenCalled();
		expect(subs.forgetEvent).toHaveBeenCalledWith("evt_1");
	});

	it("flushes on the retry too, since flush_due survived the failed attempt", async () => {
		subs.getBilling.mockResolvedValue({ org_id: "o1", plan: "team", flush_due: due() });
		meter.reportOrgUsage.mockRejectedValueOnce(new Error("stripe down")).mockResolvedValueOnce({ sent: 1 });
		expect((await run()).statusCode).toBe(500);
		subs.recordEventOnce.mockResolvedValue(true);
		expect((await run()).statusCode).toBe(200);
		expect(subs.clearFlushDue).toHaveBeenCalledOnce();
	});
});

describe("customer.subscription.deleted for a subscription Stripe no longer has", () => {
	const missing = () => retrieve.mockRejectedValue(Object.assign(new Error("No such subscription"), { statusCode: 404 }));

	it("applies null when the org's known subscription is the deleted one", async () => {
		missing();
		subs.getBilling.mockResolvedValue({ org_id: "o1", subscription_id: "sub_1" });
		expect((await call(evt("customer.subscription.deleted", sub()))).statusCode).toBe(200);
		expect(subs.applySubscription).toHaveBeenCalledWith("o1", null, NOW);
	});

	it("skips it when the org has moved on to a different subscription", async () => {
		missing();
		subs.getBilling.mockResolvedValue({ org_id: "o1", subscription_id: "sub_2" });
		const res = await call(evt("customer.subscription.deleted", sub()));
		expect(res.statusCode).toBe(200);
		expect(subs.applySubscription).not.toHaveBeenCalled();
		expect(subs.forgetEvent).not.toHaveBeenCalled();
	});

	it("still applies null when BILLING knows no subscription", async () => {
		missing();
		subs.getBilling.mockResolvedValue({ org_id: "o1", subscription_id: null });
		await call(evt("customer.subscription.deleted", sub()));
		expect(subs.applySubscription).toHaveBeenCalledWith("o1", null, NOW);
	});
});
