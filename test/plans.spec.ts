import { describe, expect, it } from "vitest";
import { PLANS, deriveMonthlyEvents, estimatedOverageUsd, monthlyEventsFor, periodBounds, planFields, planForLookupKey, retentionFor, type PlanId } from "../services/billing/plans";
import { legacyLimits, type OrgProfile } from "../services/shared/accounts";

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
		["free", null, 50_000], ["team", null, null], ["team", 20, 900_000], ["team", 0, 500_000], ["team", 0.29, 505_800], ["pro", 30, 6_000_000], ["custom", 50, null],
	])("deriveMonthlyEvents(%s, %s) = %s", (plan, cap, want) => {
		expect(deriveMonthlyEvents(plan === "custom" ? "custom" : PLANS[plan as PlanId], cap as number | null)).toBe(want);
	});
	it("freezes the plan table, including the shared FREE_LIMITS reference", () => {
		expect(Object.isFrozen(PLANS)).toBe(true);
		expect(Object.isFrozen(PLANS.free.limits)).toBe(true);
		expect(Object.isFrozen(PLANS.team.stripe)).toBe(true);
		expect(() => { (PLANS.free.limits as { max_keys: number }).max_keys = 99; }).toThrow(TypeError);
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
	it.each([
		["free", undefined, 7], ["team", undefined, 30], ["pro", undefined, 90], ["custom", undefined, 30], ["custom", 365, 365], ["pro", 14, 14], ["weird", undefined, 30],
	])("retentionFor(%s, %s) = %s", (plan, days, want) => expect(retentionFor({ plan, retention_days: days })).toBe(want));
	it("resolves retention to 30 when there is no profile at all", () => expect(retentionFor(undefined)).toBe(30));
	it.each([
		["free", undefined, 50_000], ["team", undefined, null], ["pro", undefined, null], ["custom", undefined, null],
		["free", 10, 10], ["team", 900_000, 900_000], ["team", null, null], ["free", null, null],
	])("monthlyEventsFor(%s, stored %s) = %s", (plan, stored, want) => {
		expect(monthlyEventsFor({ plan, limits: { monthly_events: stored } })).toBe(want);
	});
	it("builds the tenant plan fields from a profile", () => {
		const now = Date.parse("2026-10-23T12:00:00Z");
		const base = { limits: PLANS.pro.limits } as unknown as OrgProfile;
		expect(planFields({ ...base, plan: "pro", period_start: "2026-10-15", period_end: "2026-11-15" }, now)).toMatchObject({
			plan: "pro", retention_days: 90, period_start: "2026-10-15", period_end: "2026-11-15",
		});
		expect(planFields({ ...base, plan: "free" }, now)).toMatchObject({ plan: "free", retention_days: 7, period_start: "2026-10-01", period_end: "2026-11-01" });
	});
});
