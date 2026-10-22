import { describe, expect, it } from "vitest";
// The dashboard modules are plain JavaScript with no declarations, so tsc sees them as untyped.
// @ts-expect-error TS7016
import { fmtCost, fmtMs, fmtPct, niceMax } from "../dashboard/shared/format.js";

describe("dashboard formatting", () => {
	it("formats like the dashboard always has", () => {
		expect(fmtCost(0)).toBe("$0");
		expect(fmtCost(0.004)).toBe("$0.0040");
		expect(fmtCost(12.5)).toBe("$12.50");
		expect(fmtMs(840)).toBe("840 ms");
		expect(fmtMs(1500)).toBe("1.5 s");
		expect(fmtPct(0.05)).toBe("5.0%");
		expect(niceMax(87)).toBeGreaterThanOrEqual(87);
	});
});
