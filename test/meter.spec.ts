import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
const stripe = vi.hoisted(() => ({
	billing: { meterEvents: { create: vi.fn() } },
	subscriptions: { retrieve: vi.fn() },
}));
vi.mock("../services/billing/stripe", () => ({ getStripe: async () => stripe }));
const cw = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
	CloudWatchClient: class {
		send = cw.send;
	},
	PutMetricDataCommand: class {
		constructor(public input: unknown) {}
	},
}));
const subs = vi.hoisted(() => ({ applySubscription: vi.fn(), getBilling: vi.fn() }));
vi.mock("../services/billing/subscriptions", () => subs);
process.env.ACCOUNTS_TABLE = "accounts";
process.env.QUOTAS_TABLE = "quotas";

const { reportOrgUsage } = await import("../services/billing/meter");
const { handler } = await import("../services/billing/meter-handler");

type Billing = Parameters<typeof reportOrgUsage>[0];
const billing = (over: object = {}): Billing => ({
	org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "active", plan: "team",
	current_period_start: "2026-10-15T00:00:00.000Z", current_period_end: "2026-11-15T00:00:00.000Z",
	cancel_at_period_end: false, spend_cap_usd: null, past_due_since: null, reported_events: 500_000, reported_period: "2026-10-15", ...over,
});

// Counters answer by their Quotas key; BILLING updates resolve unless `updateError` is given.
function setup(counters: Record<string, number>, opts: { items?: object[]; updateError?: Error } = {}) {
	ddb.send.mockReset();
	ddb.send.mockImplementation(async (cmd: { input: { Key?: { window?: string } } }) => {
		if (cmd instanceof ScanCommand) return { Items: opts.items ?? [] };
		if (cmd instanceof UpdateCommand) {
			if (opts.updateError) throw opts.updateError;
			return {};
		}
		return { Item: { used: counters[cmd.input.Key!.window!] ?? 0 } };
	});
	stripe.billing.meterEvents.create.mockReset();
	stripe.billing.meterEvents.create.mockResolvedValue({});
	cw.send.mockReset();
	cw.send.mockResolvedValue({});
}
const updates = () => ddb.send.mock.calls.map(([c]) => c).filter((c): c is UpdateCommand => c instanceof UpdateCommand);
const metrics = () => Object.fromEntries((cw.send.mock.calls[0]?.[0].input.MetricData ?? []).map((m: { MetricName: string; Value: number }) => [m.MetricName, m.Value]));

describe("reportOrgUsage", () => {
	it("sends only the new events since the last report, with a retry-safe identifier", async () => {
		setup({ "o1#month#2026-10-15": 750_000 });
		const res = await reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1_700_000_000 });
		expect(res).toEqual({ sent: 250_000 });
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledWith({
			event_name: "tracewise_events",
			payload: { stripe_customer_id: "cus_1", value: "250000" },
			identifier: "o1:2026-10-15:750000",
			timestamp: 1_700_000_000,
		});
		const update = updates()[0]!;
		expect(update.input.Key).toEqual({ pk: "ORG#o1", sk: "BILLING" });
		expect(update.input.ExpressionAttributeValues).toMatchObject({ ":counter": 750_000, ":p": "2026-10-15", ":old": 500_000 });
		expect(update.input.ConditionExpression).toBe(
			"(reported_period = :p AND reported_events = :old) OR attribute_not_exists(reported_period) OR reported_period <> :p",
		);
	});

	it("starts from zero when the period changed", async () => {
		setup({ "o1#month#2026-10-15": 40_000 });
		const res = await reportOrgUsage(billing({ reported_period: "2026-09-15", reported_events: 900_000 }), { periodStart: "2026-10-15", timestamp: 1 });
		expect(res).toEqual({ sent: 40_000 });
		expect(stripe.billing.meterEvents.create.mock.calls[0]![0].payload.value).toBe("40000");
	});

	it("starts from zero when nothing was ever reported", async () => {
		setup({ "o1#month#2026-10-15": 7 });
		const res = await reportOrgUsage(billing({ reported_period: null, reported_events: 0 }), { periodStart: "2026-10-15", timestamp: 1 });
		expect(res).toEqual({ sent: 7 });
	});

	it("sends nothing when there's nothing new", async () => {
		setup({ "o1#month#2026-10-15": 500_000 });
		expect(await reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(updates()).toHaveLength(0);
	});

	it("flushes the previous period with a timestamp inside it", async () => {
		setup({ "o1#month#2026-09-15": 620_000 });
		const periodEnd = Date.parse("2026-10-15T00:00:00Z") / 1000;
		const b = billing({ reported_period: "2026-09-15", reported_events: 600_000 });
		expect(await reportOrgUsage(b, { periodStart: "2026-09-15", timestamp: periodEnd - 1 })).toEqual({ sent: 20_000 });
		expect(stripe.billing.meterEvents.create.mock.calls[0]![0]).toMatchObject({ timestamp: periodEnd - 1, identifier: "o1:2026-09-15:620000" });
	});

	it("reads the counter ingest writes when given the full ISO period start", async () => {
		setup({ "o1#month#2026-10-15": 10 });
		const res = await reportOrgUsage(billing({ reported_events: 0 }), { periodStart: "2026-10-15T00:00:00.000Z", timestamp: 1 });
		expect(res).toEqual({ sent: 10 });
		expect(stripe.billing.meterEvents.create.mock.calls[0]![0].identifier).toBe("o1:2026-10-15:10");
	});

	it("loses the race politely", async () => {
		setup({ "o1#month#2026-10-15": 750_000 }, { updateError: Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" }) });
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).resolves.toEqual({ sent: 0 });
	});

	it("surfaces other bookkeeping failures, and a Stripe failure leaves BILLING untouched", async () => {
		setup({ "o1#month#2026-10-15": 750_000 }, { updateError: new Error("throttled") });
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).rejects.toThrow("throttled");
		setup({ "o1#month#2026-10-15": 750_000 });
		stripe.billing.meterEvents.create.mockRejectedValue(new Error("stripe down"));
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).rejects.toThrow("stripe down");
		expect(updates()).toHaveLength(0);
	});
});

describe("meter handler", () => {
	const org = (id: string, over: object = {}) => billing({ org_id: id, customer_id: `cus_${id}`, reported_events: 0, ...over });
	const counters = { "a#month#2026-10-15": 5, "b#month#2026-10-15": 6, "c#month#2026-10-15": 7 };

	it("scans live BILLING items and reports each org for its own period", async () => {
		setup(counters, { items: [org("a"), org("b")] });
		await handler();
		const scan = ddb.send.mock.calls.map(([c]) => c).find((c) => c instanceof ScanCommand) as ScanCommand;
		expect(scan.input.FilterExpression).toContain("sk = :b");
		expect(Object.values(scan.input.ExpressionAttributeValues!)).toEqual(expect.arrayContaining(["BILLING", "active", "trialing", "past_due"]));
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(2);
		expect(metrics()).toEqual({ MeterOrgsReported: 2, MeterFailures: 0, MeterLastSuccessAgeMinutes: 0 });
		expect(cw.send.mock.calls[0]![0].input.Namespace).toBe("Tracewise/Billing");
	});

	it("follows scan pagination", async () => {
		setup(counters);
		let page = 0;
		ddb.send.mockImplementation(async (cmd: { input: { Key?: { window?: string } } }) => {
			if (cmd instanceof ScanCommand) return page++ === 0 ? { Items: [org("a")], LastEvaluatedKey: { pk: "x" } } : { Items: [org("b")] };
			if (cmd instanceof UpdateCommand) return {};
			return { Item: { used: counters[cmd.input.Key!.window as keyof typeof counters] } };
		});
		await handler();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(2);
	});

	it("uses the calendar month for a paid org without Stripe dates, as ingest does", async () => {
		const month = new Date().toISOString().slice(0, 8) + "01";
		setup({ [`a#month#${month}`]: 3 }, { items: [org("a", { current_period_start: null, current_period_end: null, reported_period: null })] });
		await handler();
		expect(stripe.billing.meterEvents.create.mock.calls[0]![0].identifier).toBe(`a:${month}:3`);
	});

	it("keeps going when one org fails, and fails the run only if all do", async () => {
		setup(counters, { items: [org("a"), org("b"), org("c")] });
		stripe.billing.meterEvents.create.mockImplementation(async (p: { payload: { stripe_customer_id: string } }) => {
			if (p.payload.stripe_customer_id === "cus_b") throw new Error("boom");
			return {};
		});
		await expect(handler()).resolves.toBeUndefined();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(3);
		expect(metrics()).toEqual({ MeterOrgsReported: 2, MeterFailures: 1 });

		setup(counters, { items: [org("a"), org("b"), org("c")] });
		stripe.billing.meterEvents.create.mockRejectedValue(new Error("boom"));
		await expect(handler()).rejects.toThrow("all 3 orgs");
		expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 3 });
	});

	it("is healthy with nothing to meter", async () => {
		setup({});
		await expect(handler()).resolves.toBeUndefined();
		expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 0, MeterLastSuccessAgeMinutes: 0 });
	});

	it("never runs more than 5 orgs at once", async () => {
		const items = Array.from({ length: 12 }, (_, i) => org(`o${i}`));
		setup(Object.fromEntries(items.map((b) => [`${(b as { org_id: string }).org_id}#month#2026-10-15`, 1])), { items });
		let running = 0;
		let peak = 0;
		stripe.billing.meterEvents.create.mockImplementation(async () => {
			peak = Math.max(peak, ++running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
			return {};
		});
		await handler();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(12);
		expect(peak).toBe(5);
	});

	it("still publishes metrics if CloudWatch fails", async () => {
		setup(counters, { items: [org("a")] });
		cw.send.mockRejectedValue(new Error("cw down"));
		await expect(handler()).resolves.toBeUndefined();
	});

	describe("past-due grace expiry", () => {
		const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
		const pastDue = (id: string, since: string | null, over: object = {}) =>
			org(id, { status: "past_due", past_due_since: since, ...over });

		it("re-applies orgs past due for more than 7 days from Stripe's current subscription", async () => {
			setup({}, { items: [pastDue("a", daysAgo(8)), pastDue("b", daysAgo(2)), pastDue("c", null), pastDue("d", daysAgo(9), { plan: "free" })] });
			subs.applySubscription.mockReset();
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockReset();
			stripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "past_due" });
			await handler();
			expect(stripe.subscriptions.retrieve).toHaveBeenCalledExactlyOnceWith("sub_1");
			expect(subs.applySubscription).toHaveBeenCalledExactlyOnceWith("a", { id: "sub_1", status: "past_due" }, expect.any(Number));
		});

		it("treats a subscription Stripe no longer has as none", async () => {
			setup({}, { items: [pastDue("a", daysAgo(8))] });
			subs.applySubscription.mockReset();
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockReset();
			stripe.subscriptions.retrieve.mockRejectedValue(Object.assign(new Error("No such subscription"), { statusCode: 404 }));
			await handler();
			expect(subs.applySubscription).toHaveBeenCalledWith("a", null, expect.any(Number));
		});

		it("isolates failures between orgs and never fails the run for them", async () => {
			setup({}, { items: [pastDue("a", daysAgo(8), { subscription_id: "sub_a" }), pastDue("b", daysAgo(8), { subscription_id: "sub_b" })] });
			subs.applySubscription.mockReset();
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockReset();
			stripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
				if (id === "sub_a") throw new Error("stripe 500");
				return { id };
			});
			await expect(handler()).resolves.toBeUndefined();
			expect(subs.applySubscription).toHaveBeenCalledExactlyOnceWith("b", { id: "sub_b" }, expect.any(Number));
			// Counted as a failure so the stale-meter alarm covers it: no healthy datapoint.
			expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 1 });
		});

		it("counts an apply failure as a meter failure", async () => {
			setup({}, { items: [pastDue("a", daysAgo(8))] });
			subs.applySubscription.mockReset();
			subs.applySubscription.mockRejectedValue(new Error("ddb down"));
			stripe.subscriptions.retrieve.mockReset();
			stripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1" });
			await expect(handler()).resolves.toBeUndefined();
			expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 1 });
		});

		it("makes no Stripe call when nobody is past grace", async () => {
			setup({}, { items: [pastDue("a", daysAgo(1))] });
			stripe.subscriptions.retrieve.mockReset();
			await handler();
			expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
		});
	});
});

// BILLING is kept in memory here so the order of reads and writes across runs is what's tested.
describe("period rollover", () => {
	const newStart = Date.parse("2026-10-15T00:00:00Z") / 1000;

	function world(counters: Record<string, number>, initial: Billing) {
		const state = { ...initial } as Billing;
		ddb.send.mockReset();
		ddb.send.mockImplementation(async (cmd: { input: Record<string, any> }) => {
			if (cmd instanceof ScanCommand) return { Items: [{ ...state }] };
			if (cmd instanceof UpdateCommand) {
				const v = cmd.input.ExpressionAttributeValues!;
				const ok = (state.reported_period === v[":p"] && state.reported_events === v[":old"]) || state.reported_period == null || state.reported_period !== v[":p"];
				if (!ok) throw Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" });
				state.reported_events = v[":counter"];
				state.reported_period = v[":p"];
				return {};
			}
			return { Item: { used: counters[cmd.input.Key!.window] ?? 0 } };
		});
		subs.getBilling.mockReset();
		subs.getBilling.mockImplementation(async () => ({ ...state }));
		stripe.billing.meterEvents.create.mockReset();
		stripe.billing.meterEvents.create.mockResolvedValue({});
		cw.send.mockReset();
		cw.send.mockResolvedValue({});
		return state;
	}
	const sent = () => stripe.billing.meterEvents.create.mock.calls.map(([p]) => p);
	const old = () => billing({ reported_period: "2026-09-15", reported_events: 600_000 });
	const counters = { "o1#month#2026-09-15": 620_000, "o1#month#2026-10-15": 3_000 };

	it("flushes the old period's remainder, then reports the new one, and ends on the new period", async () => {
		const state = world(counters, old());
		await handler();
		expect(sent()).toEqual([
			{ event_name: "tracewise_events", payload: { stripe_customer_id: "cus_1", value: "20000" }, identifier: "o1:2026-09-15:620000", timestamp: newStart - 1 },
			expect.objectContaining({ payload: { stripe_customer_id: "cus_1", value: "3000" }, identifier: "o1:2026-10-15:3000" }),
		]);
		expect(state).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
	});

	it("still advances when the old period has nothing left to flush", async () => {
		const state = world(counters, billing({ reported_period: "2026-09-15", reported_events: 620_000 }));
		await handler();
		expect(sent()).toHaveLength(1);
		expect(state).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
	});

	it("does not resend a finished period when reported_period is already newer", async () => {
		world(counters, billing({ reported_period: "2026-10-15", reported_events: 1_000 }));
		expect(await reportOrgUsage(billing({ reported_period: "2026-10-15", reported_events: 1_000 }), { periodStart: "2026-09-15", timestamp: newStart - 1 })).toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(ddb.send).not.toHaveBeenCalled();
	});

	it("a webhook-style flush after the meter has advanced sends nothing for the old period", async () => {
		const state = world(counters, old());
		await handler();
		expect(sent()).toHaveLength(2);
		// The webhook flushes the old period from a fresh view of BILLING.
		const res = await reportOrgUsage({ ...state }, { periodStart: "2026-09-15", timestamp: newStart - 1 });
		expect(res).toEqual({ sent: 0 });
		expect(sent()).toHaveLength(2);
	});

	it("flushing first and then moving on is safe in the other order too", async () => {
		const state = world(counters, old());
		await reportOrgUsage({ ...state }, { periodStart: "2026-09-15", timestamp: newStart - 1 });
		await handler();
		// One old-period event (the webhook's), one for the new period; nothing resent.
		expect(sent().map((p) => p.identifier)).toEqual(["o1:2026-09-15:620000", "o1:2026-10-15:3000"]);
	});
});
