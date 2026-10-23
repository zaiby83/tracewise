import { describe, expect, it } from "vitest";
import { customPatch } from "../scripts/lib/limits";
import { FREE_LIMITS } from "../services/shared/accounts";

describe("customPatch", () => {
	it("marks a free or paid org custom with 30-day retention", () => {
		const limits = { ...FREE_LIMITS, max_members: 10 };
		for (const plan of ["free", "team", "pro"]) expect(customPatch(limits, plan)).toEqual({ limits, plan: "custom", retention_days: 30 });
	});

	it("leaves an already-custom org's retention alone", () => {
		const patch = customPatch({ ...FREE_LIMITS }, "custom");
		expect(patch).toEqual({ limits: FREE_LIMITS, plan: "custom" });
		expect(patch).not.toHaveProperty("retention_days");
	});
});
