import { describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, JWT_DATA_ROUTES, splitRouteKey } from "../services/console/route-keys";

describe("console routes", () => {
	it("lists 16 console routes, all under /v1/orgs or /v1/invites, with no duplicates", () => {
		expect(CONSOLE_ROUTES).toHaveLength(16);
		expect(new Set(CONSOLE_ROUTES).size).toBe(16);
		for (const r of CONSOLE_ROUTES) expect(splitRouteKey(r).path).toMatch(/^\/v1\/(orgs|invites)/);
	});
	it("splits a route key", () => expect(splitRouteKey("DELETE /v1/orgs/{orgId}")).toEqual({ method: "DELETE", path: "/v1/orgs/{orgId}" }));
	it("names the data routes that accept a console session", () => {
		expect(Object.values(JWT_DATA_ROUTES).map((r) => splitRouteKey(r).method)).toEqual(["GET", "GET", "GET"]);
	});
});
