import { describe, expect, it } from "vitest";
import { customPatch } from "../scripts/lib/limits";
import { FREE_LIMITS } from "../services/shared/accounts";

describe("customPatch", () => {
	it("marks the org custom with 30-day retention", () => {
		expect(customPatch({ ...FREE_LIMITS, max_members: 10 })).toEqual({ limits: { ...FREE_LIMITS, max_members: 10 }, plan: "custom", retention_days: 30 });
	});
});
