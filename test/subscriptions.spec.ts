import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
process.env.ACCOUNTS_TABLE = "accounts";

const { PLANS } = await import("../services/billing/plans");
const { applySubscription, clearFlushDue, completeEvent, effectivePlan, forgetEvent, getBilling, linkCustomer, orgForCustomer, recordEventOnce } = await import(
	"../services/billing/subscriptions"
);

const NOW = Date.parse("2026-10-23T00:00:00Z");
const START = Date.parse("2026-10-10T00:00:00Z") / 1000;
const END = Date.parse("2026-11-10T00:00:00Z") / 1000;

// Stripe 23 keeps the period on the item; `onSub` places it on the subscription instead, as older API versions did.
function sub(status: string, key: string, opts: { onSub?: boolean; extra?: object[] } = {}): Stripe.Subscription {
	const period = { current_period_start: START, current_period_end: END };
	const items = [{ price: { lookup_key: key.replace("monthly", "metered") } }, { price: { lookup_key: key }, ...(opts.onSub ? {} : period) }, ...(opts.extra ?? [])];
	return { id: "sub_1", customer: "cus_1", status, cancel_at_period_end: false, items: { data: items }, ...(opts.onSub ? period : {}) } as unknown as Stripe.Subscription;
}

const profile = (over: object = {}) => ({ org_id: "o1", status: "active", plan: "free", limits: PLANS.free.limits, ...over });
const billing = (over: object = {}) => ({
	org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "active", plan: "team",
	current_period_start: new Date(START * 1000).toISOString(), current_period_end: new Date(END * 1000).toISOString(),
	cancel_at_period_end: false, spend_cap_usd: null, past_due_since: null, reported_events: 12, reported_period: "2026-10-10", ...over,
});

// Reads (Get) answer from the given items; the transaction resolves unless `txError` is given.
function setup(opts: { profile?: object | null; billing?: object | null; txError?: Error }) {
	ddb.send.mockReset();
	ddb.send.mockImplementation(async (cmd: { input: { Key?: { sk: string } }; constructor: { name: string } }) => {
		if (cmd.constructor.name === "GetCommand") return { Item: (cmd.input.Key!.sk === "PROFILE" ? opts.profile : opts.billing) ?? undefined };
		if (opts.txError) throw opts.txError;
		return {};
	});
}
const tx = () => {
	const call = ddb.send.mock.calls.find(([c]) => c instanceof TransactWriteCommand)?.[0] as TransactWriteCommand | undefined;
	const items = call?.input.TransactItems ?? [];
	return { call, profile: items.find((i) => i.Update?.Key?.sk === "PROFILE")?.Update, billing: items.find((i) => i.Update?.Key?.sk === "BILLING")?.Update };
};
const cancelled = (...codes: string[]) =>
	Object.assign(new Error("tx"), { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) });

describe("effectivePlan", () => {
	it.each([
		["active", "team_monthly", null, "team"], ["trialing", "pro_monthly", null, "pro"], ["canceled", "team_monthly", null, "free"],
		["unpaid", "pro_monthly", null, "free"], ["incomplete_expired", "team_monthly", null, "free"],
		["past_due", "team_monthly", "2026-10-20T00:00:00Z", "team"], ["past_due", "team_monthly", "2026-10-10T00:00:00Z", "free"],
		["past_due", "pro_monthly", null, "pro"], ["paused", "team_monthly", null, "free"],
	])("status %s on %s (past due since %s) → %s", (status, key, since, want) => {
		expect(effectivePlan(sub(status, key), since, Date.parse("2026-10-23T00:00:00Z"))).toBe(want);
	});
	it("makes no change for a status it does not know", () => expect(effectivePlan(sub("something_new", "team_monthly"), null)).toBeNull());
	it("treats no subscription as free", () => expect(effectivePlan(null, null)).toBe("free"));
	it("leaves an incomplete subscription alone", () => expect(effectivePlan(sub("incomplete", "team_monthly"), null)).toBeNull());
	it("grants a full seven days of grace, then ends it", () => {
		expect(effectivePlan(sub("past_due", "team_monthly"), "2026-10-16T00:00:00Z", NOW)).toBe("team");
		expect(effectivePlan(sub("past_due", "team_monthly"), "2026-10-15T23:59:59Z", NOW)).toBe("free");
	});
	it("takes the plan from the base item, ignoring the metered one", () => {
		const s = sub("active", "pro_monthly");
		s.items.data.reverse();
		expect(effectivePlan(s, null)).toBe("pro");
	});
	it("makes no change when an active subscription has no recognisable base price", () => {
		const s = { ...sub("active", "team_monthly"), items: { data: [{ price: { lookup_key: "team_metered" } }, { price: { lookup_key: null } }] } } as unknown as Stripe.Subscription;
		expect(effectivePlan(s, null)).toBeNull();
	});
});

describe("applySubscription", () => {
	it("writes plan limits, retention and period to the profile, keeping the spend cap", async () => {
		setup({ profile: profile(), billing: billing({ spend_cap_usd: 20 }) });
		const res = await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(res).toMatchObject({ plan: "team", periodChanged: false, applied: true });
		const { profile: p, billing: b } = tx();
		expect(p!.ExpressionAttributeValues).toMatchObject({
			":plan": "team", ":retention": 30, ":ps": "2026-10-10", ":pe": "2026-11-10", ":active": "active", ":custom": "custom",
			":limits": { ...PLANS.team.limits, monthly_events: 900_000 },
		});
		expect(p!.ConditionExpression).toBe("#s = :active AND #p <> :custom");
		// The BILLING write never overwrites the cap or the meter's counters.
		expect(b!.UpdateExpression).not.toMatch(/spend_cap_usd = :|reported_events = :|reported_period = :/);
		expect(b!.UpdateExpression).toMatch(/spend_cap_usd = if_not_exists/);
		expect(b!.ExpressionAttributeValues).toMatchObject({
			":plan": "team", ":status": "active", ":sub": "sub_1", ":cus": "cus_1", ":cancel": false, ":pd": null,
			":cps": "2026-10-10T00:00:00.000Z", ":cpe": "2026-11-10T00:00:00.000Z",
		});
	});
	it("leaves monthly_events uncapped on a paid plan with no spend cap", async () => {
		setup({ profile: profile(), billing: null });
		await applySubscription("o1", sub("active", "pro_monthly"), NOW);
		expect(tx().profile!.ExpressionAttributeValues![":limits"]).toEqual({ ...PLANS.pro.limits, monthly_events: null });
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":cap": null, ":zero": 0 });
	});
	it("reads the period from the subscription when the API version still puts it there", async () => {
		setup({ profile: profile(), billing: null });
		await applySubscription("o1", sub("active", "team_monthly", { onSub: true }), NOW);
		expect(tx().profile!.ExpressionAttributeValues).toMatchObject({ ":ps": "2026-10-10", ":pe": "2026-11-10" });
	});
	it("downgrades to free without touching keys, members or stored data", async () => {
		setup({ profile: profile({ plan: "team", limits: PLANS.team.limits }), billing: billing({ spend_cap_usd: 20 }) });
		const res = await applySubscription("o1", sub("canceled", "team_monthly"), NOW);
		expect(res.plan).toBe("free");
		const { profile: p, billing: b } = tx();
		expect(p!.ExpressionAttributeValues).toMatchObject({ ":plan": "free", ":retention": 7, ":limits": PLANS.free.limits });
		expect(p!.UpdateExpression).toMatch(/REMOVE period_start, period_end/);
		expect(p!.ExpressionAttributeValues).not.toHaveProperty(":ps");
		expect(b!.ExpressionAttributeValues).toMatchObject({ ":plan": "free", ":status": "canceled" });
		const names = ddb.send.mock.calls.map(([c]) => c.constructor.name);
		expect(names).not.toContain("DeleteCommand");
		expect(JSON.stringify(tx().call!.input)).not.toContain('"Delete"');
	});
	it("treats a deleted subscription as free, keeping the customer link", async () => {
		setup({ profile: profile({ plan: "pro", limits: PLANS.pro.limits }), billing: billing({ plan: "pro" }) });
		const res = await applySubscription("o1", null, NOW);
		expect(res).toMatchObject({ plan: "free", periodChanged: true });
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":plan": "free", ":status": "canceled", ":sub": null, ":cus": "cus_1", ":cps": null, ":cancel": false });
	});
	it("sets past_due_since on the first past_due and keeps it while past due", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing() });
		await applySubscription("o1", sub("past_due", "team_monthly"), NOW);
		expect(tx().billing!.ExpressionAttributeValues![":pd"]).toBe("2026-10-23T00:00:00.000Z");
		expect(tx().profile!.ExpressionAttributeValues![":plan"]).toBe("team");

		setup({ profile: profile({ plan: "team" }), billing: billing({ status: "past_due", past_due_since: "2026-10-20T00:00:00.000Z" }) });
		await applySubscription("o1", sub("past_due", "team_monthly"), NOW);
		expect(tx().billing!.ExpressionAttributeValues![":pd"]).toBe("2026-10-20T00:00:00.000Z");
	});
	it("moves to free once past due for more than seven days", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing({ status: "past_due", past_due_since: "2026-10-10T00:00:00.000Z" }) });
		const res = await applySubscription("o1", sub("past_due", "team_monthly"), NOW);
		expect(res.plan).toBe("free");
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":status": "past_due", ":plan": "free", ":pd": "2026-10-10T00:00:00.000Z" });
	});
	it("clears past_due_since once the subscription recovers", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing({ status: "past_due", past_due_since: "2026-10-20T00:00:00.000Z" }) });
		await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(tx().billing!.ExpressionAttributeValues![":pd"]).toBeNull();
	});
	it("writes nothing for an incomplete subscription", async () => {
		setup({ profile: profile(), billing: null });
		const res = await applySubscription("o1", sub("incomplete", "team_monthly"), NOW);
		expect(res).toMatchObject({ applied: false, periodChanged: false, previous: null });
		expect(tx().call).toBeUndefined();
	});
	it("never changes a custom or deleting org", async () => {
		for (const over of [{ plan: "custom" }, { status: "deleting" }, { status: "suspended" }]) {
			setup({ profile: profile(over), billing: null });
			expect(await applySubscription("o1", sub("active", "team_monthly"), NOW)).toMatchObject({ applied: false, periodChanged: false });
			expect(tx().call).toBeUndefined();
		}
		setup({ profile: null, billing: null });
		expect((await applySubscription("o1", sub("active", "team_monthly"), NOW)).applied).toBe(false);
		expect(tx().call).toBeUndefined();
	});
	it("treats a failed profile condition (a race with deletion) as skipped, not an error", async () => {
		setup({ profile: profile(), billing: null, txError: cancelled("ConditionalCheckFailed", "None") });
		expect(await applySubscription("o1", sub("active", "team_monthly"), NOW)).toMatchObject({ applied: false, periodChanged: false });
	});
	it("still throws on other transaction failures", async () => {
		setup({ profile: profile(), billing: null, txError: cancelled("ThrottlingError", "None") });
		await expect(applySubscription("o1", sub("active", "team_monthly"), NOW)).rejects.toThrow("tx");
	});
	it("reports when the billing period moved", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing({ current_period_start: "2026-09-10T00:00:00.000Z" }) });
		const res = await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(res.periodChanged).toBe(true);
		expect(res.previous).toMatchObject({ current_period_start: "2026-09-10T00:00:00.000Z", reported_events: 12 });
	});
	describe("flush_due", () => {
		const prevDue = { period: "2026-09-10", period_end: "2026-11-10T00:00:00.000Z" };
		const dueOf = () => tx().billing!.ExpressionAttributeValues![":fd"];

		it("is written with the move on a rollover, naming the period left and its end", async () => {
			setup({ profile: profile({ plan: "team" }), billing: billing({ current_period_start: "2026-09-10T00:00:00.000Z" }) });
			await applySubscription("o1", sub("active", "team_monthly"), NOW);
			expect(dueOf()).toEqual(prevDue);
			// An older owed period keeps its place; the meter settles it first.
			expect(tx().billing!.UpdateExpression).toMatch(/flush_due = if_not_exists\(flush_due, :fd\)/);
		});

		it("is written when a paid plan ends, in the same transaction", async () => {
			setup({ profile: profile({ plan: "team" }), billing: billing() });
			await applySubscription("o1", sub("canceled", "team_monthly"), NOW);
			expect(dueOf()).toEqual({ period: "2026-10-10", period_end: "2026-11-10T00:00:00.000Z" });
			expect(tx().call!.input.TransactItems).toHaveLength(2);
		});

		it("is written when a deleted subscription drops a paid plan", async () => {
			setup({ profile: profile({ plan: "pro" }), billing: billing({ plan: "pro" }) });
			await applySubscription("o1", null, NOW);
			expect(dueOf()).toEqual({ period: "2026-10-10", period_end: "2026-11-10T00:00:00.000Z" });
		});

		it.each([
			["a plain update", { plan: "team" }, () => sub("active", "team_monthly")],
			["free to free", { plan: "free" }, () => sub("canceled", "team_monthly")],
		])("is not written for %s", async (_n, over, make) => {
			setup({ profile: profile(), billing: billing(over) });
			await applySubscription("o1", make(), NOW);
			expect(tx().billing!.UpdateExpression).not.toContain("flush_due");
			expect(tx().billing!.ExpressionAttributeValues).not.toHaveProperty(":fd");
		});

		it("is not written for a first subscription, or when the old period has no dates", async () => {
			setup({ profile: profile(), billing: null });
			await applySubscription("o1", sub("active", "team_monthly"), NOW);
			expect(tx().billing!.UpdateExpression).not.toContain("flush_due");
			setup({ profile: profile({ plan: "team" }), billing: billing({ current_period_end: null }) });
			await applySubscription("o1", sub("canceled", "team_monthly"), NOW);
			expect(tx().billing!.UpdateExpression).not.toContain("flush_due");
		});
	});
	it("does not report a period change for a first subscription", async () => {
		setup({ profile: profile(), billing: null });
		expect(await applySubscription("o1", sub("active", "team_monthly"), NOW)).toMatchObject({ periodChanged: false, previous: null });
	});
	it("ignores a stale canceled subscription while a newer one is live", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		setup({ profile: profile({ plan: "pro" }), billing: billing({ plan: "pro", subscription_id: "sub_new" }) });
		const res = await applySubscription("o1", sub("canceled", "team_monthly"), NOW);
		expect(res).toMatchObject({ applied: false, plan: "pro", periodChanged: false });
		expect(tx().call).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("o1"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("sub_new"));
		warn.mockRestore();
	});
	it("applies a new live subscription replacing an old canceled one", async () => {
		setup({ profile: profile({ plan: "free" }), billing: billing({ plan: "free", status: "canceled", subscription_id: "sub_old" }) });
		expect(await applySubscription("o1", sub("active", "pro_monthly"), NOW)).toMatchObject({ applied: true, plan: "pro" });
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":sub": "sub_1", ":plan": "pro" });
	});
	it("applies a new live subscription over another live one", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing({ subscription_id: "sub_old" }) });
		expect((await applySubscription("o1", sub("active", "pro_monthly"), NOW)).applied).toBe(true);
	});
	it("still applies a deleted (null) subscription over a live record", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing() });
		expect((await applySubscription("o1", null, NOW)).applied).toBe(true);
	});
	it("conditions the BILLING write on the spend cap it read, matching a null or absent cap", async () => {
		setup({ profile: profile(), billing: billing({ spend_cap_usd: 20 }) });
		await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(tx().billing!.ConditionExpression).toBe("(attribute_not_exists(spend_cap_usd) OR spend_cap_usd = :readCap)");
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":readCap": 20 });
		setup({ profile: profile(), billing: billing({ spend_cap_usd: null }) });
		await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(tx().billing!.ExpressionAttributeValues).toMatchObject({ ":readCap": null });
	});
	it("re-reads and retries once when the spend cap changed mid-update", async () => {
		const caps = [billing({ spend_cap_usd: null }), billing({ spend_cap_usd: 20 })];
		let reads = 0;
		let writes = 0;
		const written: Record<string, unknown>[] = [];
		ddb.send.mockReset();
		ddb.send.mockImplementation(async (cmd: { input: { Key?: { sk: string }; TransactItems?: { Update: { ExpressionAttributeValues: Record<string, unknown> } }[] }; constructor: { name: string } }) => {
			if (cmd.constructor.name === "GetCommand") return { Item: cmd.input.Key!.sk === "PROFILE" ? profile() : caps[reads++] };
			written.push(cmd.input.TransactItems![0]!.Update.ExpressionAttributeValues);
			if (writes++ === 0) throw cancelled("None", "ConditionalCheckFailed");
			return {};
		});
		const res = await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(res.applied).toBe(true);
		expect(written).toHaveLength(2);
		expect((written[0]![":limits"] as { monthly_events: number | null }).monthly_events).toBeNull();
		expect((written[1]![":limits"] as { monthly_events: number | null }).monthly_events).toBe(900_000);
	});
	it("throws when the spend cap changes again on the retry", async () => {
		setup({ profile: profile(), billing: billing(), txError: cancelled("None", "ConditionalCheckFailed") });
		await expect(applySubscription("o1", sub("active", "team_monthly"), NOW)).rejects.toThrow("tx");
		expect(ddb.send.mock.calls.filter(([c]) => c instanceof TransactWriteCommand)).toHaveLength(2);
	});
	it("reads the customer id from an expanded customer object", async () => {
		setup({ profile: profile(), billing: null });
		await applySubscription("o1", { ...sub("active", "team_monthly"), customer: { id: "cus_9" } } as unknown as Stripe.Subscription, NOW);
		expect(tx().billing!.ExpressionAttributeValues![":cus"]).toBe("cus_9");
	});
});

describe("deleting a subscription that may have been superseded", () => {
	const stripeGone = (e = "sub_1") => applySubscription("o1", null, NOW, e);

	it("leaves a newer subscription alone when BILLING already moved on", async () => {
		setup({ profile: profile({ plan: "pro" }), billing: billing({ plan: "pro", subscription_id: "sub_2" }) });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await stripeGone();
		expect(res).toMatchObject({ applied: false, plan: "pro" });
		expect(ddb.send.mock.calls.some(([c]) => c instanceof TransactWriteCommand)).toBe(false);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("guards the BILLING write on the subscription id it expects", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing() });
		expect(await stripeGone()).toMatchObject({ applied: true, plan: "free" });
		const b = tx().billing!;
		expect(b.ConditionExpression).toBe(
			"(attribute_not_exists(spend_cap_usd) OR spend_cap_usd = :readCap) AND (attribute_not_exists(subscription_id) OR attribute_type(subscription_id, :nullType) OR subscription_id = :expected)",
		);
		expect(b.ExpressionAttributeValues).toMatchObject({ ":expected": "sub_1", ":nullType": "NULL" });
	});

	it("skips when a newer subscription lands between the read and the write", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let reads = 0;
		let writes = 0;
		ddb.send.mockReset();
		ddb.send.mockImplementation(async (cmd: { input: { Key?: { sk: string } }; constructor: { name: string } }) => {
			if (cmd.constructor.name === "GetCommand") {
				if (cmd.input.Key!.sk === "PROFILE") return { Item: profile({ plan: "team" }) };
				// The first read still shows the deleted subscription; by the second the org has a new one.
				return { Item: billing(++reads > 1 ? { subscription_id: "sub_2" } : {}) };
			}
			writes++;
			throw cancelled("None", "ConditionalCheckFailed");
		});
		expect(await stripeGone()).toMatchObject({ applied: false });
		expect(writes).toBe(1);
	});

	it("does not add the guard to an ordinary update or to a deletion with no expected id", async () => {
		setup({ profile: profile({ plan: "team" }), billing: billing() });
		await applySubscription("o1", sub("active", "team_monthly"), NOW);
		expect(tx().billing!.ConditionExpression).not.toContain("subscription_id");
		setup({ profile: profile({ plan: "team" }), billing: billing() });
		await applySubscription("o1", null, NOW);
		expect(tx().billing!.ConditionExpression).not.toContain("subscription_id");
	});
});

describe("billing records", () => {
	it("getBilling reads ORG#id / BILLING and returns null when missing", async () => {
		setup({ billing: null });
		expect(await getBilling("o1")).toBeNull();
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ Key: { pk: "ORG#o1", sk: "BILLING" } });
		setup({ billing: { pk: "ORG#o1", sk: "BILLING", ...billing() } });
		expect(await getBilling("o1")).toEqual(billing());
	});
	it("maps a Stripe customer to its org and back", async () => {
		ddb.send.mockReset().mockResolvedValueOnce({ Item: { pk: "STRIPE#cus_1", sk: "CUSTOMER", org_id: "o1" } }).mockResolvedValueOnce({});
		expect(await orgForCustomer("cus_1")).toBe("o1");
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ Key: { pk: "STRIPE#cus_1", sk: "CUSTOMER" } });
		await linkCustomer("o1", "cus_1");
		expect(ddb.send.mock.calls[1]![0].input).toMatchObject({
			TableName: "accounts",
			Item: { pk: "STRIPE#cus_1", sk: "CUSTOMER", org_id: "o1" },
			ConditionExpression: "attribute_not_exists(pk) OR org_id = :org",
			ExpressionAttributeValues: { ":org": "o1" },
		});
		ddb.send.mockReset().mockResolvedValueOnce({});
		expect(await orgForCustomer("cus_unknown")).toBeNull();
	});
});

describe("linkCustomer", () => {
	it("refuses to move a customer to a different org, without naming ids", async () => {
		ddb.send.mockReset().mockRejectedValueOnce(Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" }));
		const err = await linkCustomer("o2", "cus_1").catch((e) => e);
		expect(err.message).toBe("Stripe customer is already linked to a different org");
		ddb.send.mockReset().mockRejectedValueOnce(new Error("throttled"));
		await expect(linkCustomer("o2", "cus_1")).rejects.toThrow("throttled");
	});
});

describe("clearFlushDue", () => {
	it("removes the marker only for the period that was reported", async () => {
		setup({ profile: null, billing: null });
		await clearFlushDue("o1", "2026-09-10");
		const cmd = ddb.send.mock.calls[0]![0] as { input: Record<string, any> };
		expect(cmd.input.Key).toEqual({ pk: "ORG#o1", sk: "BILLING" });
		expect(cmd.input.UpdateExpression).toBe("REMOVE flush_due");
		expect(cmd.input.ConditionExpression).toBe("flush_due.#p = :p");
		expect(cmd.input.ExpressionAttributeValues).toEqual({ ":p": "2026-09-10" });
	});
	it("treats a marker already cleared or replaced as done, but not other errors", async () => {
		setup({ profile: null, billing: null, txError: undefined });
		ddb.send.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" }));
		await expect(clearFlushDue("o1", "2026-09-10")).resolves.toBeUndefined();
		ddb.send.mockRejectedValueOnce(new Error("down"));
		await expect(clearFlushDue("o1", "2026-09-10")).rejects.toThrow("down");
	});
});

describe("webhook event records", () => {
	it("claims each Stripe event with a lease, and treats a finished or live one as a duplicate", async () => {
		ddb.send.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error("dup"), { name: "ConditionalCheckFailedException" }));
		expect(await recordEventOnce("evt_1", "invoice.paid", NOW)).toBe(true);
		const input = ddb.send.mock.calls[0]![0].input;
		expect(input).toMatchObject({
			// A lapsed lease is taken over; anything else already recorded is a duplicate.
			ConditionExpression: "attribute_not_exists(pk) OR (#st = :processing AND lease_until < :now)",
			ExpressionAttributeNames: { "#st": "status" },
			ExpressionAttributeValues: { ":processing": "processing", ":now": NOW / 1000 },
			Item: { pk: "STRIPE_EVENT#evt_1", sk: "EVENT", type: "invoice.paid", status: "processing", lease_until: NOW / 1000 + 300, received_at: "2026-10-23T00:00:00.000Z" },
		});
		expect(input.Item.expires_at - NOW / 1000).toBe(30 * 86_400);
		expect(await recordEventOnce("evt_1", "invoice.paid", NOW)).toBe(false);
	});
	it("takes over a stale processing record: the lease time it compares against is the current time", async () => {
		// The condition is DynamoDB's to evaluate; what matters here is that a later delivery asks with a later `now`.
		ddb.send.mockReset().mockResolvedValue({});
		await recordEventOnce("evt_1", "invoice.paid", NOW);
		await recordEventOnce("evt_1", "invoice.paid", NOW + 600_000);
		const nows = ddb.send.mock.calls.map(([c]) => c.input.ExpressionAttributeValues[":now"]);
		expect(nows[1] - nows[0]).toBe(600);
		expect(ddb.send.mock.calls[1]![0].input.Item.lease_until).toBe(NOW / 1000 + 600 + 300);
	});
	it("marks an event done once it has been handled, ending its lease", async () => {
		ddb.send.mockReset().mockResolvedValueOnce({});
		await completeEvent("evt_1");
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({
			Key: { pk: "STRIPE_EVENT#evt_1", sk: "EVENT" },
			UpdateExpression: "SET #st = :done REMOVE lease_until",
			ConditionExpression: "attribute_exists(pk)",
			ExpressionAttributeValues: { ":done": "done" },
		});
	});
	it("does not hide other failures as duplicates", async () => {
		ddb.send.mockReset().mockRejectedValueOnce(new Error("throttled"));
		await expect(recordEventOnce("evt_2", "invoice.paid")).rejects.toThrow("throttled");
	});
	it("forgets an event so a retry is processed", async () => {
		ddb.send.mockReset().mockResolvedValueOnce({});
		await forgetEvent("evt_1");
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ Key: { pk: "STRIPE_EVENT#evt_1", sk: "EVENT" } });
	});
});
