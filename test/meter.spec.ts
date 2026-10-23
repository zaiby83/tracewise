import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const subs = vi.hoisted(() => ({ applySubscription: vi.fn(), getBilling: vi.fn(), clearFlushDue: vi.fn() }));
vi.mock("../services/billing/subscriptions", () => subs);
process.env.ACCOUNTS_TABLE = "accounts";
process.env.QUOTAS_TABLE = "quotas";

const { isDuplicateIdentifier, reportOrgUsage } = await import("../services/billing/meter");
const { handler } = await import("../services/billing/meter-handler");

type Billing = Parameters<typeof reportOrgUsage>[0];
const billing = (over: object = {}): Billing => ({
	org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "active", plan: "team",
	current_period_start: "2026-10-15T00:00:00.000Z", current_period_end: "2026-11-15T00:00:00.000Z",
	cancel_at_period_end: false, spend_cap_usd: null, past_due_since: null, reported_events: 500_000, reported_period: "2026-10-15", ...over,
});

const lost = () => Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" });
const duplicate = () =>
	Object.assign(new Error("An event with this identifier already exists."), { type: "StripeInvalidRequestError", statusCode: 400 });

// An in-memory BILLING table behind the DynamoDB mock, so what is tested is the order of reads and
// writes. The claim and clear conditions are mirrored here; their text is asserted separately.
function world(counters: Record<string, number>, initial: Billing[] = [], opts: { claimError?: Error; scanPages?: boolean } = {}) {
	const state = new Map<string, Billing>(initial.map((b) => [b.org_id, { ...b }]));
	const events: string[] = [];
	ddb.send.mockReset();
	ddb.send.mockImplementation(async (cmd: { input: Record<string, any> }) => {
		if (cmd instanceof ScanCommand) {
			const all = [...state.values()].map((b) => ({ ...b }));
			if (!opts.scanPages) return { Items: all };
			const start = cmd.input.ExclusiveStartKey?.i ?? 0;
			return { Items: [all[start]], ...(start + 1 < all.length ? { LastEvaluatedKey: { i: start + 1 } } : {}) };
		}
		if (cmd instanceof UpdateCommand) {
			const s = state.get(cmd.input.Key!.pk.replace("ORG#", ""))!;
			const v = cmd.input.ExpressionAttributeValues!;
			if (cmd.input.UpdateExpression!.startsWith("REMOVE")) {
				if (s.pending?.identifier !== v[":id"]) throw lost();
				delete s.pending;
				events.push("clear");
				return {};
			}
			if (opts.claimError) throw opts.claimError;
			const ok = !s.pending && (s.reported_period == null || (s.reported_period === v[":p"] && s.reported_events === v[":old"]) || s.reported_period < v[":p"]);
			if (!ok) throw lost();
			s.reported_events = v[":counter"];
			s.reported_period = v[":p"];
			s.pending = v[":event"];
			events.push("claim");
			return {};
		}
		return { Item: { used: counters[cmd.input.Key!.window] ?? 0 } };
	});
	subs.clearFlushDue.mockReset();
	subs.clearFlushDue.mockImplementation(async (id: string, period: string) => {
		const s = state.get(id)!;
		if (s.flush_due?.period !== period) return;
		delete s.flush_due;
		events.push("clearDue");
	});
	subs.getBilling.mockReset();
	subs.getBilling.mockImplementation(async (id: string) => (state.has(id) ? { ...state.get(id)! } : null));
	stripe.billing.meterEvents.create.mockReset();
	stripe.billing.meterEvents.create.mockImplementation(async () => {
		events.push("send");
		return {};
	});
	stripe.subscriptions.retrieve.mockReset();
	subs.applySubscription.mockReset();
	cw.send.mockReset();
	cw.send.mockResolvedValue({});
	return { state, events };
}
const sent = () => stripe.billing.meterEvents.create.mock.calls.map(([p]) => p);
const metrics = () => Object.fromEntries((cw.send.mock.calls[0]?.[0].input.MetricData ?? []).map((m: { MetricName: string; Value: number }) => [m.MetricName, m.Value]));
const reportedKey = { "o1#month#2026-10-15": 750_000 };

afterEach(() => vi.useRealTimers());

describe("reportOrgUsage", () => {
	it("claims, then sends only the new events with a retry-safe identifier, then clears the claim", async () => {
		const { state, events } = world(reportedKey, [billing()]);
		const res = await reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1_700_000_000 });
		expect(res).toEqual({ sent: 250_000 });
		expect(sent()).toEqual([
			{
				event_name: "tracewise_events",
				payload: { stripe_customer_id: "cus_1", value: "250000" },
				identifier: "o1:2026-10-15:750000",
				timestamp: 1_700_000_000,
			},
		]);
		// The claim has to land before Stripe is called.
		expect(events).toEqual(["claim", "send", "clear"]);
		expect(state.get("o1")).toMatchObject({ reported_events: 750_000, reported_period: "2026-10-15" });
		expect(state.get("o1")!.pending).toBeUndefined();
	});

	it("records the event it is about to send, under a forward-only condition", async () => {
		world(reportedKey, [billing()]);
		await reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1_700_000_000 });
		const claim = ddb.send.mock.calls.map(([c]) => c).find((c) => c instanceof UpdateCommand) as UpdateCommand;
		expect(claim.input.Key).toEqual({ pk: "ORG#o1", sk: "BILLING" });
		expect(claim.input.ExpressionAttributeValues).toMatchObject({
			":counter": 750_000, ":p": "2026-10-15", ":old": 500_000, ":nullType": "NULL",
			":event": { identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 1_700_000_000, period: "2026-10-15" },
		});
		expect(claim.input.ConditionExpression).toBe(
			"attribute_exists(pk) AND attribute_not_exists(#pend) AND (attribute_not_exists(reported_period) OR attribute_type(reported_period, :nullType) OR " +
				"(reported_period = :p AND reported_events = :old) OR reported_period < :p)",
		);
		expect(claim.input.ConditionExpression).not.toContain("<>");
	});

	it("starts from zero when the period changed", async () => {
		world({ "o1#month#2026-10-15": 40_000 }, [billing({ reported_period: "2026-09-15", reported_events: 900_000 })]);
		const res = await reportOrgUsage(billing({ reported_period: "2026-09-15", reported_events: 900_000 }), { periodStart: "2026-10-15", timestamp: 1 });
		expect(res).toEqual({ sent: 40_000 });
		expect(sent()[0].payload.value).toBe("40000");
	});

	it("starts from zero when nothing was ever reported", async () => {
		const b = billing({ reported_period: null, reported_events: 0 });
		const { state } = world({ "o1#month#2026-10-15": 7 }, [b]);
		expect(await reportOrgUsage(b, { periodStart: "2026-10-15", timestamp: 1 })).toEqual({ sent: 7 });
		expect(state.get("o1")!.reported_period).toBe("2026-10-15");
	});

	it("sends nothing when there's nothing new", async () => {
		world({ "o1#month#2026-10-15": 500_000 }, [billing()]);
		expect(await reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(ddb.send.mock.calls.filter(([c]) => c instanceof UpdateCommand)).toHaveLength(0);
	});

	it("flushes the previous period with a timestamp inside it", async () => {
		const b = billing({ reported_period: "2026-09-15", reported_events: 600_000 });
		world({ "o1#month#2026-09-15": 620_000 }, [b]);
		const periodEnd = Date.parse("2026-10-15T00:00:00Z") / 1000;
		expect(await reportOrgUsage(b, { periodStart: "2026-09-15", timestamp: periodEnd - 1 })).toEqual({ sent: 20_000 });
		expect(sent()[0]).toMatchObject({ timestamp: periodEnd - 1, identifier: "o1:2026-09-15:620000" });
	});

	it("compares periods as dates on both sides, whatever shape BILLING holds", async () => {
		const b = billing({ reported_period: "2026-10-15T00:00:00.000Z", reported_events: 500_000 });
		world(reportedKey, [billing()]);
		const res = await reportOrgUsage(b, { periodStart: "2026-10-15T00:00:00.000Z", timestamp: 1 });
		// Same period: the delta is against reported_events, not the whole counter.
		expect(res).toEqual({ sent: 250_000 });
		expect(sent()[0].identifier).toBe("o1:2026-10-15:750000");
	});

	it("does not resend a finished period when reported_period is already newer", async () => {
		const b = billing({ reported_period: "2026-10-15", reported_events: 1_000 });
		world({ "o1#month#2026-09-15": 620_000 }, [b]);
		expect(await reportOrgUsage(b, { periodStart: "2026-09-15", timestamp: 1 })).toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(ddb.send).not.toHaveBeenCalled();
	});

	it("loses the race politely: no Stripe call when the claim is refused", async () => {
		// Another run already moved reported_events on from what this one read.
		const { state } = world(reportedKey, [billing({ reported_events: 700_000 })]);
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).resolves.toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(state.get("o1")!.reported_events).toBe(700_000);
	});

	it("refuses a stale writer, so BILLING never moves back to an older period", async () => {
		// The meter has advanced to October; a flush holding an old read still shows September.
		const { state } = world({ "o1#month#2026-09-15": 620_000 }, [billing({ reported_period: "2026-10-15", reported_events: 3_000 })]);
		const stale = billing({ reported_period: "2026-09-15", reported_events: 600_000 });
		await expect(reportOrgUsage(stale, { periodStart: "2026-09-15", timestamp: 1 })).resolves.toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		expect(state.get("o1")).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
	});

	it("refuses a writer whose view predates a pending claim", async () => {
		const pending = { identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 1, period: "2026-10-15" };
		world({ "o1#month#2026-10-15": 800_000 }, [billing({ reported_events: 750_000, pending })]);
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).resolves.toEqual({ sent: 0 });
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
	});

	it("does not call Stripe when the claim write fails for another reason", async () => {
		world(reportedKey, [billing()], { claimError: new Error("throttled") });
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1 })).rejects.toThrow("throttled");
		expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
	});

	it("keeps the claim pending when the send fails, and re-sends exactly it first on the next run", async () => {
		const { state, events } = world(reportedKey, [billing()]);
		stripe.billing.meterEvents.create.mockRejectedValueOnce(new Error("stripe down"));
		await expect(reportOrgUsage(billing(), { periodStart: "2026-10-15", timestamp: 1_700_000_000 })).rejects.toThrow("stripe down");
		expect(state.get("o1")!.pending).toEqual({ identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 1_700_000_000, period: "2026-10-15" });
		expect(state.get("o1")).toMatchObject({ reported_events: 750_000 });

		// Next run: the counter has moved on, and the view comes from BILLING.
		world({ "o1#month#2026-10-15": 760_000 }, [state.get("o1")!]);
		const next = await reportOrgUsage(state.get("o1")!, { periodStart: "2026-10-15", timestamp: 1_700_003_600 });
		expect(sent().map((p) => [p.identifier, p.payload.value, p.timestamp])).toEqual([
			["o1:2026-10-15:750000", "250000", 1_700_000_000],
			["o1:2026-10-15:760000", "10000", 1_700_003_600],
		]);
		expect(next).toEqual({ sent: 260_000 });
		void events;
	});

	it("clears the pending claim after re-sending it, before claiming anything new", async () => {
		const pending = { identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 5, period: "2026-10-15" };
		const b = billing({ reported_events: 750_000, pending });
		const { state, events } = world({ "o1#month#2026-10-15": 760_000 }, [b]);
		await reportOrgUsage(b, { periodStart: "2026-10-15", timestamp: 9 });
		expect(events).toEqual(["send", "clear", "claim", "send", "clear"]);
		expect(state.get("o1")!.pending).toBeUndefined();
		expect(state.get("o1")!.reported_events).toBe(760_000);
	});

	it("treats Stripe's duplicate-identifier refusal on a re-send as delivered", async () => {
		const pending = { identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 5, period: "2026-10-15" };
		const b = billing({ reported_events: 750_000, pending });
		const { state } = world({ "o1#month#2026-10-15": 750_000 }, [b]);
		stripe.billing.meterEvents.create.mockRejectedValueOnce(duplicate());
		await expect(reportOrgUsage(b, { periodStart: "2026-10-15", timestamp: 9 })).resolves.toEqual({ sent: 250_000 });
		expect(state.get("o1")!.pending).toBeUndefined();
	});

	it("keeps the claim when a re-send fails for any other reason", async () => {
		const pending = { identifier: "o1:2026-10-15:750000", value: "250000", timestamp: 5, period: "2026-10-15" };
		const b = billing({ reported_events: 750_000, pending });
		const { state } = world({ "o1#month#2026-10-15": 900_000 }, [b]);
		stripe.billing.meterEvents.create.mockRejectedValue(Object.assign(new Error("Too many requests"), { type: "StripeRateLimitError", statusCode: 429 }));
		await expect(reportOrgUsage(b, { periodStart: "2026-10-15", timestamp: 9 })).rejects.toThrow("Too many");
		expect(state.get("o1")!.pending).toBeDefined();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(1);
	});

	it("recognises a duplicate identifier narrowly", () => {
		expect(isDuplicateIdentifier(duplicate())).toBe(true);
		expect(isDuplicateIdentifier(Object.assign(new Error("x"), { code: "resource_already_exists" }))).toBe(true);
		expect(isDuplicateIdentifier(Object.assign(new Error("No such billing meter"), { type: "StripeInvalidRequestError", statusCode: 400 }))).toBe(false);
		expect(isDuplicateIdentifier(Object.assign(new Error("Invalid timestamp"), { type: "StripeInvalidRequestError", statusCode: 400 }))).toBe(false);
		expect(isDuplicateIdentifier(Object.assign(new Error("identifier already used"), { type: "StripeAPIError", statusCode: 500 }))).toBe(false);
		expect(isDuplicateIdentifier(new Error("boom"))).toBe(false);
	});
});

describe("meter handler", () => {
	const org = (id: string, over: object = {}) => billing({ org_id: id, customer_id: `cus_${id}`, reported_events: 0, ...over });
	const counters = { "a#month#2026-10-15": 5, "b#month#2026-10-15": 6, "c#month#2026-10-15": 7 };

	it("scans live BILLING items and reports each org for its own period", async () => {
		world(counters, [org("a"), org("b")]);
		await handler();
		const scan = ddb.send.mock.calls.map(([c]) => c).find((c) => c instanceof ScanCommand) as ScanCommand;
		expect(scan.input.FilterExpression).toContain("sk = :b");
		expect(Object.values(scan.input.ExpressionAttributeValues!)).toEqual(expect.arrayContaining(["BILLING", "active", "trialing", "past_due"]));
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(2);
		expect(metrics()).toEqual({ MeterOrgsReported: 2, MeterFailures: 0, MeterLastSuccessAgeMinutes: 0 });
		expect(cw.send.mock.calls[0]![0].input.Namespace).toBe("Tracewise/Billing");
	});

	it("also scans BILLING items that still hold a pending event, or a flush_due, whatever their status", async () => {
		world(counters, [org("a")]);
		await handler();
		const scan = ddb.send.mock.calls.map(([c]) => c).find((c) => c instanceof ScanCommand) as ScanCommand;
		// A cancelled org is no longer live, but a claimed-and-unsent event of its last period must still go out.
		expect(scan.input.FilterExpression).toBe(
			"sk = :b AND (#s IN (:active, :trialing, :pastDue) OR attribute_exists(#pend) OR attribute_exists(flush_due))",
		);
		expect(scan.input.ExpressionAttributeNames).toEqual({ "#s": "status", "#pend": "pending" });
	});

	describe("flush_due", () => {
		const month = new Date().toISOString().slice(0, 8) + "01";
		const flushDue = { period: "2026-09-15", period_end: "2026-10-15T00:00:00Z" };
		const canceled = (over: object = {}) =>
			org("a", { status: "canceled", plan: "free", reported_period: "2026-09-15", reported_events: 100, flush_due: flushDue, ...over });

		it("reports a canceled org's final period, clears the marker, and never reads the calendar month", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
			const { state, events } = world({ "a#month#2026-09-15": 250, [`a#month#${month}`]: 30_000 }, [canceled({ current_period_start: null, current_period_end: null })]);
			await handler();
			expect(sent().map((p) => [p.identifier, p.payload.value, p.timestamp])).toEqual([["a:2026-09-15:250", "150", Date.parse("2026-10-15T00:00:00Z") / 1000 - 1]]);
			expect(events).toEqual(["claim", "send", "clear", "clearDue"]);
			expect(state.get("a")!.flush_due).toBeUndefined();
			const windows = ddb.send.mock.calls.map(([c]) => c.input?.Key?.window).filter(Boolean);
			expect(windows).toEqual(["a#month#2026-09-15"]);
		});

		it("settles it before the live period, for an org that rolled over", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
			const b = org("a", {
				reported_period: "2026-09-15", reported_events: 100, flush_due: flushDue,
				current_period_start: "2026-10-15T00:00:00.000Z", current_period_end: "2026-11-15T00:00:00.000Z",
			});
			const { state, events } = world({ "a#month#2026-09-15": 250, "a#month#2026-10-15": 40 }, [b]);
			await handler();
			expect(sent().map((p) => p.identifier)).toEqual(["a:2026-09-15:250", "a:2026-10-15:40"]);
			expect(events.indexOf("clearDue")).toBeLessThan(events.lastIndexOf("claim"));
			expect(state.get("a")!.flush_due).toBeUndefined();
		});

		it("keeps the marker when the report fails, so the next run tries again", async () => {
			const { state } = world({ "a#month#2026-09-15": 250 }, [canceled()]);
			stripe.billing.meterEvents.create.mockRejectedValue(new Error("boom"));
			await expect(handler()).rejects.toThrow("all 1 orgs");
			expect(state.get("a")!.flush_due).toEqual(flushDue);
			expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 1 });
		});

		it("sends only a pending claim for a canceled org, never a new period", async () => {
			const pending = { identifier: "a:2026-09-15:9", value: "9", timestamp: 77, period: "2026-09-15" };
			const { state } = world({ "a#month#2026-09-15": 9, [`a#month#${month}`]: 500 }, [canceled({ flush_due: undefined, reported_events: 9, pending })]);
			await handler();
			expect(sent().map((p) => [p.identifier, p.timestamp])).toEqual([["a:2026-09-15:9", 77]]);
			expect(state.get("a")!.pending).toBeUndefined();
		});

		it("leaves a canceled org with nothing owed alone", async () => {
			world({ [`a#month#${month}`]: 500 }, [canceled({ flush_due: undefined })]);
			await handler();
			expect(stripe.billing.meterEvents.create).not.toHaveBeenCalled();
		});
	});

	it("follows scan pagination", async () => {
		world(counters, [org("a"), org("b")], { scanPages: true });
		await handler();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(2);
	});

	it("uses the calendar month only when BILLING has no period dates, as ingest does then", async () => {
		const month = new Date().toISOString().slice(0, 8) + "01";
		world({ [`a#month#${month}`]: 3 }, [org("a", { current_period_start: null, current_period_end: null, reported_period: null })]);
		await handler();
		expect(sent()[0].identifier).toBe(`a:${month}:3`);
	});

	it("keeps going when one org fails, and fails the run only if all do", async () => {
		world(counters, [org("a"), org("b"), org("c")]);
		stripe.billing.meterEvents.create.mockImplementation(async (p: { payload: { stripe_customer_id: string } }) => {
			if (p.payload.stripe_customer_id === "cus_b") throw new Error("boom");
			return {};
		});
		await expect(handler()).resolves.toBeUndefined();
		expect(stripe.billing.meterEvents.create).toHaveBeenCalledTimes(3);
		expect(metrics()).toEqual({ MeterOrgsReported: 2, MeterFailures: 1 });

		world(counters, [org("a"), org("b"), org("c")]);
		stripe.billing.meterEvents.create.mockRejectedValue(new Error("boom"));
		await expect(handler()).rejects.toThrow("all 3 orgs");
		expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 3 });
	});

	it("is healthy with nothing to meter", async () => {
		world({});
		await expect(handler()).resolves.toBeUndefined();
		expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 0, MeterLastSuccessAgeMinutes: 0 });
	});

	it("never runs more than 5 orgs at once", async () => {
		const items = Array.from({ length: 12 }, (_, i) => org(`o${i}`));
		world(Object.fromEntries(items.map((b) => [`${b.org_id}#month#2026-10-15`, 1])), items);
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
		world(counters, [org("a")]);
		cw.send.mockRejectedValue(new Error("cw down"));
		await expect(handler()).resolves.toBeUndefined();
	});

	it("re-sends a claim left pending by an earlier run before anything new", async () => {
		const pending = { identifier: "a:2026-10-15:5", value: "5", timestamp: 77, period: "2026-10-15" };
		const { state } = world({ "a#month#2026-10-15": 9 }, [org("a", { reported_events: 5, pending })]);
		await handler();
		expect(sent().map((p) => [p.identifier, p.payload.value, p.timestamp])).toEqual([
			["a:2026-10-15:5", "5", 77],
			expect.arrayContaining(["a:2026-10-15:9", "4"]),
		]);
		expect(state.get("a")!.pending).toBeUndefined();
	});

	it("meters a grace-expired org on its Stripe period, never the Free calendar month", async () => {
		const month = new Date().toISOString().slice(0, 8) + "01";
		const b = org("a", { plan: "free", status: "past_due", past_due_since: new Date(Date.now() - 9 * 86_400_000).toISOString(), reported_events: 400_000 });
		const { state } = world({ "a#month#2026-10-15": 450_000, [`a#month#${month}`]: 30_000 }, [b]);
		await handler();
		expect(sent().map((p) => [p.identifier, p.payload.value])).toEqual([["a:2026-10-15:450000", "50000"]]);
		expect(state.get("a")).toMatchObject({ reported_period: "2026-10-15", reported_events: 450_000 });
		// A second run finds nothing new.
		await handler();
		expect(sent()).toHaveLength(1);
		const windows = ddb.send.mock.calls.map(([c]) => c.input?.Key?.window).filter(Boolean);
		expect(windows).not.toContain(`a#month#${month}`);
	});

	describe("event timestamps", () => {
		const endSeconds = Date.parse("2026-11-15T00:00:00.000Z") / 1000;

		it("never stamps a late event after its period's end", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-11-15T00:40:00Z"));
			world({ "a#month#2026-10-15": 5 }, [org("a")]);
			await handler();
			expect(sent()[0].timestamp).toBe(endSeconds - 1);
		});

		it("uses the current time inside the period", async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
			world({ "a#month#2026-10-15": 5 }, [org("a")]);
			await handler();
			expect(sent()[0].timestamp).toBe(Date.parse("2026-10-23T10:00:00Z") / 1000);
		});
	});

	describe("past-due grace expiry", () => {
		const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
		const pastDue = (id: string, since: string | null, over: object = {}) => org(id, { status: "past_due", past_due_since: since, ...over });

		it("re-applies orgs past due for more than 7 days from Stripe's current subscription", async () => {
			world({}, [pastDue("a", daysAgo(8)), pastDue("b", daysAgo(2)), pastDue("c", null), pastDue("d", daysAgo(9), { plan: "free" })]);
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "past_due" });
			await handler();
			expect(stripe.subscriptions.retrieve).toHaveBeenCalledExactlyOnceWith("sub_1");
			expect(subs.applySubscription).toHaveBeenCalledExactlyOnceWith("a", { id: "sub_1", status: "past_due" }, expect.any(Number));
		});

		it("treats a subscription Stripe no longer has as none", async () => {
			world({}, [pastDue("a", daysAgo(8))]);
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockRejectedValue(Object.assign(new Error("No such subscription"), { statusCode: 404 }));
			await handler();
			expect(subs.applySubscription).toHaveBeenCalledWith("a", null, expect.any(Number));
		});

		it("isolates failures between orgs, and counts them so the alarm covers them", async () => {
			world({}, [pastDue("a", daysAgo(8), { subscription_id: "sub_a" }), pastDue("b", daysAgo(8), { subscription_id: "sub_b" })]);
			subs.applySubscription.mockResolvedValue({ plan: "free", applied: true });
			stripe.subscriptions.retrieve.mockImplementation(async (id: string) => {
				if (id === "sub_a") throw new Error("stripe 500");
				return { id };
			});
			await expect(handler()).resolves.toBeUndefined();
			expect(subs.applySubscription).toHaveBeenCalledExactlyOnceWith("b", { id: "sub_b" }, expect.any(Number));
			expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 1 });
		});

		it("counts an apply failure as a meter failure", async () => {
			world({}, [pastDue("a", daysAgo(8))]);
			subs.applySubscription.mockRejectedValue(new Error("ddb down"));
			stripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1" });
			await expect(handler()).resolves.toBeUndefined();
			expect(metrics()).toEqual({ MeterOrgsReported: 0, MeterFailures: 1 });
		});

		it("makes no Stripe call when nobody is past grace", async () => {
			world({}, [pastDue("a", daysAgo(1))]);
			await handler();
			expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
		});
	});
});

describe("period rollover", () => {
	const newStart = Date.parse("2026-10-15T00:00:00Z") / 1000;
	const old = () => billing({ reported_period: "2026-09-15", reported_events: 600_000 });
	const counters = { "o1#month#2026-09-15": 620_000, "o1#month#2026-10-15": 3_000 };

	it("flushes the old period's remainder, then reports the new one, and ends on the new period", async () => {
		const { state } = world(counters, [old()]);
		await handler();
		expect(sent()).toEqual([
			{ event_name: "tracewise_events", payload: { stripe_customer_id: "cus_1", value: "20000" }, identifier: "o1:2026-09-15:620000", timestamp: newStart - 1 },
			expect.objectContaining({ payload: { stripe_customer_id: "cus_1", value: "3000" }, identifier: "o1:2026-10-15:3000" }),
		]);
		expect(state.get("o1")).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
		expect(state.get("o1")!.pending).toBeUndefined();
	});

	it("still advances when the old period has nothing left to flush", async () => {
		const { state } = world(counters, [billing({ reported_period: "2026-09-15", reported_events: 620_000 })]);
		await handler();
		expect(sent()).toHaveLength(1);
		expect(state.get("o1")).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
	});

	it("a webhook-style flush after the meter has advanced sends nothing for the old period", async () => {
		const { state } = world(counters, [old()]);
		await handler();
		expect(sent()).toHaveLength(2);
		// From a fresh view, and from a stale one: neither resends September.
		await expect(reportOrgUsage({ ...state.get("o1")! }, { periodStart: "2026-09-15", timestamp: newStart - 1 })).resolves.toEqual({ sent: 0 });
		await expect(reportOrgUsage(old(), { periodStart: "2026-09-15", timestamp: newStart - 1 })).resolves.toEqual({ sent: 0 });
		expect(sent()).toHaveLength(2);
		expect(state.get("o1")).toMatchObject({ reported_period: "2026-10-15", reported_events: 3_000 });
	});

	it("flushing first and then running the meter is safe in the other order too", async () => {
		const { state } = world(counters, [old()]);
		await reportOrgUsage(old(), { periodStart: "2026-09-15", timestamp: newStart - 1 });
		await handler();
		expect(sent().map((p) => p.identifier)).toEqual(["o1:2026-09-15:620000", "o1:2026-10-15:3000"]);
		expect(state.get("o1")!.reported_period).toBe("2026-10-15");
	});
});
