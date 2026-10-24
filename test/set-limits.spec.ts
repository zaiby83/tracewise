import { describe, expect, it } from "vitest";
import { customPatch, setLimitsRefusal } from "../scripts/lib/limits";
import { FREE_LIMITS } from "../services/shared/accounts";

describe("customPatch", () => {
	it("marks a free or paid org custom with 30-day retention", () => {
		const limits = { ...FREE_LIMITS, max_members: 10 };
		for (const plan of ["free", "team", "pro"]) expect(customPatch(limits, plan)).toEqual({ limits, plan: "custom", retention_days: 30, remove: ["period_start", "period_end"] });
	});

	it("drops the Stripe period from the profile, so a custom org counts by calendar month", () => {
		expect(customPatch({ ...FREE_LIMITS }, "team").remove).toEqual(["period_start", "period_end"]);
		expect(customPatch({ ...FREE_LIMITS }, "custom").remove).toEqual(["period_start", "period_end"]);
	});

	it("leaves an already-custom org's retention alone", () => {
		const patch = customPatch({ ...FREE_LIMITS }, "custom");
		expect(patch).toEqual({ limits: FREE_LIMITS, plan: "custom", remove: ["period_start", "period_end"] });
		expect(patch).not.toHaveProperty("retention_days");
	});
});

describe("setLimitsRefusal", () => {
	it.each(["active", "trialing", "past_due", "unpaid", "incomplete"])("refuses an org whose Stripe subscription is %s", (status) => {
		expect(setLimitsRefusal({ status, subscription_id: "sub_1" })).toMatch(/cancel the Stripe subscription first/);
	});

	it.each([
		["no billing record", null],
		["a customer with no subscription", { status: "none", subscription_id: null }],
		["a canceled subscription", { status: "canceled", subscription_id: "sub_1" }],
		["an expired checkout", { status: "incomplete_expired", subscription_id: "sub_1" }],
	])("allows an org with %s", (_name, billing) => {
		expect(setLimitsRefusal(billing)).toBeNull();
	});
});
