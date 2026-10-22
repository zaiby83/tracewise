import { AthenaClient } from "@aws-sdk/client-athena";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BY_DAY, BY_ROUTE, parameters, sinceDate, toObjects } from "../services/analytics/queries";

const auth = vi.hoisted(() => ({ resolveTenant: vi.fn(), jwtClaims: vi.fn() }));
vi.mock("../services/shared/auth", () => auth);
const tenants = vi.hoisted(() => ({
	consumeCounter: vi.fn(),
	counterIds: { athena: (org: string) => `${org}#athena#day` },
	secondsUntilUtcMidnight: () => 3600,
}));
vi.mock("../services/shared/tenants", () => tenants);

const { handler } = await import("../services/analytics/handler");
const tenant = { tenant_id: "o1", org_id: "o1", name: "Acme", status: "active", limits: { analytics_queries_per_day: 200 } };
const keyRequest = (query: Record<string, string> = {}) => ({ headers: {}, queryStringParameters: query, requestContext: {} }) as never;

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

describe("analytics handler", () => {
	let athenaSend: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		auth.resolveTenant.mockReset();
		auth.jwtClaims.mockReset();
		tenants.consumeCounter.mockReset();
		athenaSend = vi.spyOn(AthenaClient.prototype, "send").mockRejectedValue(new Error("unexpected athena call") as never);
	});

	it("refuses once the org's daily analytics cap is used", async () => {
		auth.resolveTenant.mockResolvedValue(tenant);
		tenants.consumeCounter.mockResolvedValue(false);
		const res = await handler(keyRequest({ days: "7" }));
		expect(res.statusCode).toBe(429);
		expect(res.headers).toMatchObject({ "x-tracewise-limit": "analytics", "retry-after": "3600" });
		expect(JSON.parse(res.body!)).toEqual({ error: "daily analytics query cap reached" });
		expect(athenaSend).not.toHaveBeenCalled();
		expect(tenants.consumeCounter).toHaveBeenCalledWith("o1#athena#day", 1, 200, expect.any(Number));
		const expiresAt = tenants.consumeCounter.mock.calls[0]![3] as number;
		expect(expiresAt).toBeGreaterThan(Date.now() / 1000 + 86_400);
	});

	it("does not spend the cap on an invalid request", async () => {
		auth.resolveTenant.mockResolvedValue(tenant);
		expect((await handler(keyRequest({ days: "0" }))).statusCode).toBe(400);
		expect(tenants.consumeCounter).not.toHaveBeenCalled();
	});

	it("answers 401 on the key path and 404 on the console path when there is no tenant", async () => {
		auth.resolveTenant.mockResolvedValue(null);
		auth.jwtClaims.mockReturnValue(null);
		const key = await handler(keyRequest());
		expect(key.statusCode).toBe(401);
		expect(JSON.parse(key.body!)).toEqual({ error: "invalid API key" });
		auth.jwtClaims.mockReturnValue({ sub: "u", email: "", email_verified: false });
		const jwt = await handler(keyRequest());
		expect(jwt.statusCode).toBe(404);
		expect(JSON.parse(jwt.body!)).toEqual({ error: "not found" });
	});
});
