import { describe, expect, it } from "vitest";
import { expectedMeteredCents, validateSmokeArgs } from "../scripts/lib/smoke-billing";
import { PLANS } from "../services/billing/plans";

describe("validateSmokeArgs", () => {
	it("prints usage for --help without needing a key", () => {
		const r = validateSmokeArgs(["--help"], {});
		expect(r).toMatchObject({ ok: false, help: true });
		expect(!r.ok && r.message).toMatch(/smoke-billing\.ts/);
	});

	it("needs a key and refuses live ones without echoing them", () => {
		expect(validateSmokeArgs([], {})).toMatchObject({ ok: false, help: false });
		const live = validateSmokeArgs([], { STRIPE_SECRET_KEY: "sk_live_supersecret" });
		expect(live.ok).toBe(false);
		expect(JSON.stringify(live)).not.toContain("supersecret");
		expect(validateSmokeArgs([], { STRIPE_SECRET_KEY: "rk_live_x" }).ok).toBe(false);
		expect(validateSmokeArgs([], { STRIPE_SECRET_KEY: "pk_test_x" }).ok).toBe(false);
	});

	it("accepts a test key, with or without --overage, and rejects other flags", () => {
		expect(validateSmokeArgs([], { STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({ ok: true, overage: false });
		expect(validateSmokeArgs(["--overage"], { STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({ ok: true, overage: true });
		expect(validateSmokeArgs(["--included=5"], { STRIPE_SECRET_KEY: "sk_test_x" }).ok).toBe(false);
	});
});

describe("expectedMeteredCents", () => {
	it("charges nothing inside the allowance and the tier price beyond it", () => {
		expect(expectedMeteredCents(PLANS.team, 25)).toBe(0);
		expect(expectedMeteredCents(PLANS.team, 500_000)).toBe(0);
		expect(expectedMeteredCents(PLANS.team, 500_001)).toBe(0);
		expect(expectedMeteredCents(PLANS.team, 600_000)).toBe(500);
		expect(expectedMeteredCents(PLANS.pro, 5_100_000)).toBe(300);
		expect(expectedMeteredCents(PLANS.free, 1_000_000)).toBe(0);
	});
});
