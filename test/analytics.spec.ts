import { describe, expect, it } from "vitest";
import { BY_DAY, BY_ROUTE, parameters, sinceDate, toObjects } from "../services/analytics/queries";

describe("analytics queries", () => {
	it("always filters by tenant and date via parameters, never by string building", () => {
		for (const sql of [BY_ROUTE, BY_DAY]) {
			expect(sql).toContain("WHERE tenant_id = ? AND dt >= ?");
			expect(sql).not.toMatch(/\$\{/);
		}
	});

	it("quotes parameters as SQL literals and refuses anything unexpected", () => {
		const tenant = "bb5678cd-fc34-40aa-8c32-610f7404fc7c";
		expect(parameters(tenant, "2026-10-15")).toEqual([`'${tenant}'`, "'2026-10-15'"]);
		expect(() => parameters("x' OR '1'='1", "2026-10-15")).toThrow();
		expect(() => parameters(tenant, "2026-10-15'; DROP TABLE traces; --")).toThrow();
	});

	it("computes an inclusive start date", () => {
		const now = new Date("2026-10-21T12:00:00Z");
		expect(sinceDate(1, now)).toBe("2026-10-21");
		expect(sinceDate(7, now)).toBe("2026-10-15");
		expect(sinceDate(30, now)).toBe("2026-09-22");
	});

	it("turns Athena rows into typed objects, keeping days as strings", () => {
		const rows = [
			{ Data: [{ VarCharValue: "day" }, { VarCharValue: "calls" }, { VarCharValue: "cost_usd" }, { VarCharValue: "route" }] },
			{ Data: [{ VarCharValue: "2026-10-21" }, { VarCharValue: "250" }, { VarCharValue: "0.0125" }, {}] },
		];
		expect(toObjects(rows)).toEqual([{ day: "2026-10-21", calls: 250, cost_usd: 0.0125, route: null }]);
	});
});
