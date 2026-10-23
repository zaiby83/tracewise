import { describe, expect, it } from "vitest";
import { PLANS, deriveMonthlyEvents, estimatedOverageUsd, periodBounds, planForLookupKey, type PlanId } from "../services/billing/plans";
import { legacyLimits } from "../services/shared/accounts";

describe("plans", () => {
	it("matches the published plan values", () => {
		expect(PLANS.free).toMatchObject({ price_usd: 0, included_events: 50_000, overage_per_100k_usd: null, retention_days: 7, stripe: null });
		expect(PLANS.free.limits).toMatchObject({ events_per_minute: 600, monthly_events: 50_000, eval_samples_per_night: 20, max_members: 2, max_keys: 3, max_pending_invites: 2, analytics_queries_per_day: 200 });
		expect(PLANS.team).toMatchObject({ price_usd: 29, included_events: 500_000, overage_per_100k_usd: 5, retention_days: 30, stripe: { base: "team_monthly", metered: "team_metered" } });
		expect(PLANS.team.limits).toMatchObject({ events_per_minute: 6_000, eval_samples_per_night: 100, max_members: 10, max_keys: 20, max_pending_invites: 10, analytics_queries_per_day: 2_000, monthly_events: null });
		expect(PLANS.pro).toMatchObject({ price_usd: 199, included_events: 5_000_000, overage_per_100k_usd: 3, retention_days: 90 });
		expect(PLANS.pro.limits).toMatchObject({ events_per_minute: 30_000, eval_samples_per_night: 500, max_members: 50, max_keys: 100, max_pending_invites: 50, analytics_queries_per_day: 10_000, monthly_events: null });
	});
	it.each([
		["free", null, 50_000], ["team", null, null], ["team", 20, 900_000], ["team", 0, 500_000], ["pro", 30, 6_000_000], ["custom", 50, null],
	])("deriveMonthlyEvents(%s, %s) = %s", (plan, cap, want) => {
		expect(deriveMonthlyEvents(plan === "custom" ? "custom" : PLANS[plan as PlanId], cap as number | null)).toBe(want);
	});
	it("never estimates negative overage", () => {
		expect(estimatedOverageUsd(PLANS.team, 100_000)).toBe(0);
		expect(estimatedOverageUsd(PLANS.team, 650_000)).toBeCloseTo(7.5);
		expect(estimatedOverageUsd(PLANS.free, 80_000)).toBe(0);
	});
	it("maps lookup keys to plans", () => {
		expect(planForLookupKey("pro_monthly")).toBe("pro");
		expect(planForLookupKey("team_metered")).toBe("team");
		expect(planForLookupKey("nope")).toBeNull();
	});
	it("uses the UTC calendar month for free and the stored period for paid", () => {
		const now = Date.parse("2026-10-23T12:00:00Z");
		expect(periodBounds({ plan: "free" }, now)).toEqual({ start: "2026-10-01", end: "2026-11-01" });
		expect(periodBounds({ plan: "team", period_start: "2026-10-15", period_end: "2026-11-15" }, now)).toEqual({ start: "2026-10-15", end: "2026-11-15" });
	});
	it("falls back to the calendar month when a paid profile has no period, and rolls over the year", () => {
		expect(periodBounds({ plan: "pro" }, Date.parse("2026-12-31T23:59:00Z"))).toEqual({ start: "2026-12-01", end: "2027-01-01" });
		expect(periodBounds({ plan: "custom", period_start: "2026-10-15" }, Date.parse("2026-10-23T00:00:00Z"))).toEqual({ start: "2026-10-01", end: "2026-11-01" });
	});
	it("keeps migrated tenants unlimited per month", () => expect(legacyLimits(6000)).toMatchObject({ events_per_minute: 6000, monthly_events: null }));
});
