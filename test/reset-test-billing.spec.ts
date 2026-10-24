import { describe, expect, it } from "vitest";
import { planTestBillingReset, validateResetArgs } from "../scripts/lib/reset-test-billing";

const profile = (org_id: string, plan: string, over: object = {}) => ({ org_id, plan, status: "active", ...over });
const billing = (org_id: string, over: object = {}) => ({ org_id, status: "active", livemode: false, ...over });

describe("planTestBillingReset", () => {
	it("moves to Free every active paid org whose subscription is test mode's, or missing", () => {
		const plan = planTestBillingReset(
			[profile("a", "team"), profile("b", "pro"), profile("c", "team")],
			[billing("a"), billing("b", { livemode: undefined })],
		);
		expect(plan.reset).toEqual([
			{ org_id: "a", plan: "team", reason: "test-mode subscription" },
			{ org_id: "b", plan: "pro", reason: "test-mode subscription" },
			{ org_id: "c", plan: "team", reason: "no live subscription" },
		]);
	});

	it("keeps orgs a live subscription pays for, in any status Stripe still holds open", () => {
		const statuses = ["active", "trialing", "past_due", "unpaid", "incomplete"];
		const plan = planTestBillingReset(
			statuses.map((s) => profile(s, "team")),
			statuses.map((s) => billing(s, { status: s, livemode: true })),
		);
		expect(plan.reset).toEqual([]);
		expect(plan.kept).toBe(5);
	});

	it("resets a paid org whose live record holds no subscription (a Checkout started and left)", () => {
		const plan = planTestBillingReset([profile("a", "team"), profile("b", "pro")], [billing("a", { status: "none", livemode: true }), billing("b", { status: "canceled", livemode: true })]);
		expect(plan.reset.map((r) => [r.org_id, r.reason])).toEqual([
			["a", "no live subscription"],
			["b", "no live subscription"],
		]);
	});

	it("leaves free, custom and inactive orgs alone, whatever their billing says", () => {
		const plan = planTestBillingReset(
			[profile("f", "free"), profile("c", "custom"), profile("d", "team", { status: "deleting" }), profile("s", "pro", { status: "suspended" })],
			[billing("f"), billing("c"), billing("d"), billing("s")],
		);
		expect(plan.reset).toEqual([]);
		expect(plan.kept).toBe(0);
	});
});

describe("validateResetArgs", () => {
	it("needs a live key, since it only makes sense once the secret holds one, and never echoes it", () => {
		expect(validateResetArgs([], {})).toMatchObject({ ok: false });
		const test = validateResetArgs([], { STRIPE_SECRET_KEY: "sk_test_secretvalue" });
		expect(test).toMatchObject({ ok: false, message: expect.stringMatching(/live key/) });
		expect(JSON.stringify(test)).not.toContain("secretvalue");
		expect(validateResetArgs([], { STRIPE_SECRET_KEY: "pk_live_x" }).ok).toBe(false);
	});

	it("is a dry run unless --apply is given", () => {
		expect(validateResetArgs([], { STRIPE_SECRET_KEY: "sk_live_x" })).toEqual({ ok: true, apply: false });
		expect(validateResetArgs(["--apply"], { STRIPE_SECRET_KEY: "rk_live_x" })).toEqual({ ok: true, apply: true });
	});

	it("rejects unknown arguments and prints usage for --help", () => {
		expect(validateResetArgs(["--force"], { STRIPE_SECRET_KEY: "sk_live_x" })).toMatchObject({ ok: false, help: false });
		expect(validateResetArgs(["--help"], {})).toMatchObject({ ok: false, help: true, message: expect.stringMatching(/reset-test-billing\.ts/) });
	});
});
