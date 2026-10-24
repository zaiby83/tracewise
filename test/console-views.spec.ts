import { describe, expect, it } from "vitest";
import { FREE_LIMITS } from "../services/shared/accounts";
import { curlQuickstart } from "../dashboard/console/views/overview.js";
import { usageRows } from "../dashboard/console/views/usage.js";
import { PLAN_DETAILS, billingActions, billingSummary, checkoutRefusal, roundCents } from "../dashboard/console/views/billing.js";
import { bannersFor } from "../dashboard/console/banners.js";
import { PLANS } from "../services/billing/plans";

describe("console view helpers", () => {
	it("builds a working curl quickstart", () => {
		const c = curlQuickstart("https://d1.cloudfront.net", "tw_x");
		expect(c).toContain('-X POST "https://d1.cloudfront.net/v1/traces"');
		expect(c).toContain("authorization: Bearer tw_x");
		expect(c).toMatch(/"event_id":"[0-9a-f-]{36}"/);
	});

	it("puts a fresh UUID and timestamp in each quickstart", () => {
		const a = curlQuickstart("https://x.example", "k");
		const b = curlQuickstart("https://x.example", "k");
		expect(a).toMatch(/"ts":"\d{4}-\d\d-\d\dT[\d:.]+Z"/);
		expect(a).not.toBe(b);
	});

	it("lists usage against every limit, with what happens at the cap", () => {
		const limits = { ...FREE_LIMITS, max_keys: 10, max_members: 5, max_pending_invites: 10 };
		const used = { events_this_minute: 1, events_this_period: 2, analytics_queries_today: 3, eval_samples_last_night: 4, keys: 1, members: 1, pending_invites: 0 };
		const rows = usageRows({ limits, used, plan: "free", included: 50_000 });
		expect(rows.map((r) => r.label)).toEqual(["Events this minute", "Events this period", "Analytics queries today", "Eval samples last night", "Keys", "Members", "Pending invites"]);
		expect(rows[1]).toMatchObject({ used: 2, limit: 50_000 });
		expect(rows[1]!.note).toBe("Ingest returns 429 until the period ends");
		expect(rows.map((r) => r.limit)).toEqual([600, 50_000, 200, 20, 10, 5, 10]);
		expect(rows.every((r) => r.note.length > 0)).toBe(true);
	});

	it("shows a paid plan's period events against what it includes, and says overage is billed", () => {
		const limits = { ...PLANS.team.limits, monthly_events: null };
		const used = { events_this_minute: 1, events_this_period: 650_000, analytics_queries_today: 0, eval_samples_last_night: 0, keys: 1, members: 1, pending_invites: 0 };
		const row = usageRows({ limits, used, plan: "team", included: 500_000 })[1]!;
		expect(row).toMatchObject({ label: "Events this period", used: 650_000, limit: 500_000, note: "Paid plans keep accepting events and bill overage" });
		// A spend cap turns the allowance into a ceiling, and ingest stops there.
		const capped = usageRows({ limits: { ...limits, monthly_events: 900_000 }, used, plan: "team", included: 500_000 })[1]!;
		expect(capped.limit).toBe(900_000);
		expect(capped.note).toBe("Ingest returns 429 once your spend cap is reached");
	});
});

describe("usage row states", () => {
	const used = (events: number) => ({ events_this_minute: 1, events_this_period: events, analytics_queries_today: 0, eval_samples_last_night: 0, keys: 1, members: 1, pending_invites: 0 });
	const period = (args: Parameters<typeof usageRows>[0]) => usageRows(args)[1]!;

	it("marks only a hard stop as full", () => {
		expect(period({ limits: { ...FREE_LIMITS }, used: used(50_000), plan: "free", included: 50_000 }).state).toBe("full");
		expect(period({ limits: { ...FREE_LIMITS }, used: used(49_999), plan: "free", included: 50_000 }).state).toBe("");
		// A spend cap's ceiling is a stop.
		expect(period({ limits: { ...PLANS.team.limits, monthly_events: 900_000 }, used: used(900_000), plan: "team", included: 500_000 }).state).toBe("full");
		expect(period({ limits: { ...PLANS.team.limits, monthly_events: 900_000 }, used: used(700_000), plan: "team", included: 500_000 }).state).toBe("");
	});

	it("shows a paid plan past its allowance, with no ceiling, as over rather than full", () => {
		expect(period({ limits: { ...PLANS.team.limits, monthly_events: null }, used: used(650_000), plan: "team", included: 500_000 }).state).toBe("over");
		expect(period({ limits: { ...PLANS.team.limits, monthly_events: null }, used: used(400_000), plan: "team", included: 500_000 }).state).toBe("");
	});

	it("still renders every row when billing is unavailable", () => {
		const rows = usageRows({ limits: { ...PLANS.team.limits, monthly_events: null }, used: used(650_000) });
		expect(rows).toHaveLength(7);
		expect(rows[1]).toMatchObject({ label: "Events this period", limit: null, note: "No event limit applies", state: "" });
		expect(usageRows({ limits: { ...FREE_LIMITS }, used: used(50_000) })[1]).toMatchObject({ state: "full", note: "Ingest returns 429 once this limit is reached" });
	});

	it("keeps the other limits as hard stops", () => {
		const rows = usageRows({ limits: { ...FREE_LIMITS }, used: { ...used(0), keys: 3 }, plan: "free", included: 50_000 });
		expect(rows.find((r) => r.label === "Keys")!.state).toBe("full");
	});
});

describe("spend cap", () => {
	it("rounds to whole cents", () => {
		expect(roundCents(20.499)).toBe(20.5);
		expect(roundCents(0.294)).toBe(0.29);
		expect(roundCents(100)).toBe(100);
		expect(roundCents(1.005)).toBe(1);
	});
});

describe("billing screen helpers", () => {
	const team = { plan: "team", status: "active", events_this_period: 650_000, included_events: 500_000, estimated_overage_usd: 7.5, spend_cap_usd: null, current_period_end: "2026-11-15T00:00:00Z", cancel_at_period_end: false };

	it("summarises a paid plan's usage and overage", () => {
		expect(billingSummary(team)).toMatchObject({ planLabel: "Team", overageLine: expect.stringContaining("$7.50") });
		expect(billingSummary(team).usageLine).toBe("650,000 of 500,000 events this period");
		expect(billingSummary(team).renewalLine).toBe("Renews on Nov 15, 2026");
		expect(billingSummary({ ...team, cancel_at_period_end: true }).renewalLine).toBe("Cancels on Nov 15, 2026");
		expect(billingSummary({ ...team, estimated_overage_usd: 0 }).overageLine).toBeNull();
	});

	it("summarises free and custom orgs, which have no subscription", () => {
		const free = billingSummary({ plan: "free", status: "none", events_this_period: 41_000, included_events: 50_000, estimated_overage_usd: 0, spend_cap_usd: null, current_period_end: null, cancel_at_period_end: null });
		expect(free).toMatchObject({ planLabel: "Free", usageLine: "41,000 of 50,000 events this period", overageLine: null });
		expect(free.renewalLine).toMatch(/first of each month/);
		const custom = billingSummary({ plan: "custom", status: "none", events_this_period: 9, included_events: null, estimated_overage_usd: 0, spend_cap_usd: null, current_period_end: null, cancel_at_period_end: null });
		expect(custom).toMatchObject({ planLabel: "Custom", usageLine: "9 events this period", overageLine: null });
	});

	it("shows the same plan cards the code enforces", () => {
		for (const id of ["team", "pro"] as const) {
			expect(PLAN_DETAILS[id]).toEqual({ name: PLANS[id].name, price_usd: PLANS[id].price_usd, included_events: PLANS[id].included_events, overage_per_100k_usd: PLANS[id].overage_per_100k_usd, retention_days: PLANS[id].retention_days, max_members: PLANS[id].limits.max_members });
		}
	});

	it("tells a free org about a payment problem on the subscription it still has", () => {
		for (const status of ["past_due", "unpaid"]) {
			const banners = bannersFor({ plan: "free", past_due: false, subscription_status: status, events_this_period: 10, included_events: 50_000 }, {});
			expect(banners, status).toEqual([{ kind: "danger", text: expect.stringContaining("Manage billing") }]);
		}
		expect(bannersFor({ plan: "free", subscription_status: "canceled", events_this_period: 10, included_events: 50_000 }, {})).toEqual([]);
		// A paid org that is past due keeps the grace-period message.
		expect(bannersFor({ plan: "team", past_due: true, subscription_status: "past_due", events_this_period: 0, included_events: 500_000 }, {})[0]!.text).toMatch(/7 days/);
	});

	it("raises the right banners", () => {
		expect(bannersFor({ plan: "free", events_this_period: 41_000, included_events: 50_000 }, {}).map((b) => b.kind)).toEqual(["warn"]);
		expect(bannersFor({ plan: "team", past_due: true, events_this_period: 0, included_events: 500_000 }, {}).map((b) => b.kind)).toEqual(["danger"]);
		expect(bannersFor({ plan: "free", events_this_period: 10, included_events: 50_000 }, {})).toEqual([]);
		expect(bannersFor(null, null)).toEqual([]);
	});

	it("tells a free org it has hit the cap, and a paid org it is being billed for overage", () => {
		const free = bannersFor({ plan: "free", events_this_period: 50_000, included_events: 50_000 }, {});
		expect(free).toEqual([{ kind: "danger", text: expect.stringContaining("429") }]);
		const paid = bannersFor({ plan: "team", events_this_period: 500_000, included_events: 500_000, estimated_overage_usd: 0, spend_cap_usd: null }, {});
		expect(paid.map((b) => b.kind)).toEqual(["info"]);
		expect(bannersFor({ plan: "pro", events_this_period: 4_100_000, included_events: 5_000_000 }, {}).map((b) => b.kind)).toEqual(["warn"]);
	});

	it("flags a reached spend cap, but not a cap of zero that has not been touched", () => {
		const capped = { plan: "team", events_this_period: 900_000, included_events: 500_000, estimated_overage_usd: 20, spend_cap_usd: 20 };
		expect(bannersFor(capped, {}).map((b) => b.kind)).toEqual(["danger"]);
		expect(bannersFor(capped, { limits: { monthly_events: 900_000 } }).map((b) => b.kind)).toEqual(["danger"]);
		// Over the allowance but under the ceiling the usage endpoint reports.
		expect(bannersFor({ ...capped, estimated_overage_usd: 10, events_this_period: 700_000 }, { limits: { monthly_events: 900_000 } }).map((b) => b.kind)).toEqual(["info"]);
		expect(bannersFor({ plan: "team", events_this_period: 100, included_events: 500_000, estimated_overage_usd: 0, spend_cap_usd: 0 }, {})).toEqual([]);
	});
});

describe("billing screen actions", () => {
	const view = (over: object = {}) => ({ plan: "free", status: "none", subscription_status: "none", billing_account: false, checkout_enabled: true, ...over });

	it("offers a free owner the plan cards' upgrade buttons, and Manage billing only once there is an account", () => {
		expect(billingActions(view(), true)).toEqual({ manage: false, switchTo: null, upgrade: true, note: null });
		expect(billingActions(view({ billing_account: true, subscription_status: "canceled" }), true)).toMatchObject({ manage: true, upgrade: true });
	});

	it("shows Manage billing to a downgraded org with a payment problem, and no upgrade", () => {
		const a = billingActions(view({ billing_account: true, subscription_status: "unpaid" }), true);
		expect(a).toMatchObject({ manage: true, upgrade: false, switchTo: null });
		expect(a.note).toMatch(/Manage billing/);
	});

	it("offers a paid owner the other plan while the subscription can switch", () => {
		expect(billingActions(view({ plan: "team", status: "active", subscription_status: "active", billing_account: true }), true)).toEqual({ manage: true, switchTo: "pro", upgrade: false, note: null });
		expect(billingActions(view({ plan: "pro", status: "past_due", subscription_status: "past_due", billing_account: true }), true)).toMatchObject({ switchTo: "team" });
		expect(billingActions(view({ plan: "team", status: "canceled", subscription_status: "canceled", billing_account: true }), true)).toMatchObject({ switchTo: null, manage: true });
	});

	it("hides Upgrade and Switch with a short note while paid plans are switched off, keeping Manage billing", () => {
		const free = billingActions(view({ checkout_enabled: false }), true);
		expect(free).toMatchObject({ upgrade: false, switchTo: null });
		expect(free.note).toMatch(/aren't available yet/);
		expect(billingActions(view({ plan: "team", status: "active", subscription_status: "active", billing_account: true, checkout_enabled: false }), true)).toMatchObject({ manage: true, switchTo: null });
	});

	it("hides the upgrade while a finished Checkout is being confirmed", () => {
		expect(billingActions(view(), true, { settingUp: true })).toMatchObject({ upgrade: false });
	});

	it("gives members no controls", () => {
		expect(billingActions(view({ plan: "team", status: "active", subscription_status: "active", billing_account: true }), false)).toEqual({ manage: false, switchTo: null, upgrade: false, note: null });
	});
});

describe("checkoutRefusal", () => {
	const err = (status: number, message: string) => Object.assign(new Error(message), { status });
	it("reads only the exact already-subscribed answer as a subscription being set up", () => {
		expect(checkoutRefusal(err(409, "already subscribed, use Manage billing"))).toBe("setting-up");
		expect(checkoutRefusal(err(409, "Already subscribed somewhere"))).toBeNull();
		expect(checkoutRefusal(err(500, "already subscribed, use Manage billing"))).toBeNull();
	});
	it("tells a payment problem apart", () => {
		expect(checkoutRefusal(err(409, "there's a payment problem on your subscription — use Manage billing"))).toBe("payment-problem");
		expect(checkoutRefusal(err(409, "plan is managed by Tracewise, contact support"))).toBeNull();
	});
});
