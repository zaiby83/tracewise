import { describe, expect, it } from "vitest";
import { planFreeUpgrade } from "../scripts/lib/plan-limits";
import { PLANS } from "../services/billing/plans";
import { FREE_LIMITS, type OrgProfile } from "../services/shared/accounts";

const base: OrgProfile = {
	org_id: "org1",
	name: "Acme",
	status: "active",
	plan: "free",
	// The pre-billing free allowances: a daily cap's worth of limits and the generous seat counts.
	limits: { events_per_minute: 600, monthly_events: null, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 10, max_members: 5, max_pending_invites: 10 },
	rubric: null,
	evals_enabled: true,
	owner_count: 1,
	created_at: "2026-10-01T00:00:00Z",
	created_by: "u1",
};

describe("planFreeUpgrade", () => {
	it("moves a free org on old limits to the Free plan's limits and 7-day retention", () => {
		expect(planFreeUpgrade(base)).toEqual({ limits: PLANS.free.limits, retention_days: 7 });
	});

	it("moves a free org that has the new limits but not the new retention", () => {
		expect(planFreeUpgrade({ ...base, limits: { ...FREE_LIMITS } })).toEqual({ limits: PLANS.free.limits, retention_days: 7 });
	});

	it("moves a free org whose retention is already 7 but whose limits are old", () => {
		expect(planFreeUpgrade({ ...base, retention_days: 7 })).toEqual({ limits: PLANS.free.limits, retention_days: 7 });
	});

	it("returns null for an org that already matches", () => {
		expect(planFreeUpgrade({ ...base, limits: { ...PLANS.free.limits }, retention_days: 7 })).toBeNull();
	});

	it("leaves custom, team, pro and non-active orgs alone", () => {
		expect(planFreeUpgrade({ ...base, plan: "custom" })).toBeNull();
		expect(planFreeUpgrade({ ...base, plan: "team" })).toBeNull();
		expect(planFreeUpgrade({ ...base, plan: "pro" })).toBeNull();
		expect(planFreeUpgrade({ ...base, status: "deleting" })).toBeNull();
		expect(planFreeUpgrade({ ...base, status: "deleted" })).toBeNull();
		expect(planFreeUpgrade({ ...base, status: "suspended" })).toBeNull();
	});

	it("does not hand out the shared frozen limits object", () => {
		const patch = planFreeUpgrade(base);
		expect(patch?.limits).not.toBe(PLANS.free.limits);
	});
});
