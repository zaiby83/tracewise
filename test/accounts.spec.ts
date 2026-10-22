import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
process.env.ACCOUNTS_TABLE = "accounts";

const { FREE_LIMITS, getProfile, legacyLimits, listActiveProfiles, listProfiles, listUserOrgs, normalizeEmail, touchKey } =
	await import("../services/shared/accounts");

describe("accounts", () => {
	// Reset inside the tests that count calls rather than in a beforeEach hook: with vitest 5 a
	// hook-level reset makes the rejected promise in the touchKey test fail the run.

	it("free limits match the spec", () => {
		expect(FREE_LIMITS).toEqual({ events_per_minute: 600, events_per_day: 50_000, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 10, max_members: 5, max_pending_invites: 10 });
	});
	it("legacy limits keep a migrated tenant's current behaviour", () => {
		expect(legacyLimits(6000)).toMatchObject({ events_per_minute: 6000, events_per_day: 6000 * 1440, analytics_queries_per_day: 10_000, eval_samples_per_night: 20 });
	});
	it("getProfile reads ORG#id / PROFILE and returns null when missing", async () => {
		ddb.send.mockReset().mockResolvedValueOnce({ Item: undefined });
		expect(await getProfile("o1")).toBeNull();
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ Key: { pk: "ORG#o1", sk: "PROFILE" } });
	});
	it("listUserOrgs queries USER#sub and maps items", async () => {
		ddb.send.mockResolvedValueOnce({ Items: [{ pk: "USER#u", sk: "ORG#o1", role: "owner", org_name: "Acme" }] });
		expect(await listUserOrgs("u")).toEqual([{ org_id: "o1", name: "Acme", role: "owner" }]);
	});
	it("listActiveProfiles pages through a scan and keeps only active profiles", async () => {
		ddb.send
			.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "a", status: "active" }], LastEvaluatedKey: { pk: "x" } })
			.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "b", status: "deleting" }] });
		expect((await listActiveProfiles()).map((p) => p.org_id)).toEqual(["a"]);
	});
	it("listProfiles pages through every profile, whatever its status", async () => {
		ddb.send
			.mockReset()
			.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "a", status: "active" }, { sk: "MEMBER#u", org_id: "a" }], LastEvaluatedKey: { pk: "x" } })
			.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "b", status: "deleting" }] });
		expect((await listProfiles()).map((p) => p.org_id)).toEqual(["a", "b"]);
		expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ FilterExpression: "sk = :p", ExpressionAttributeValues: { ":p": "PROFILE" } });
		expect(ddb.send.mock.calls[1]![0].input.ExclusiveStartKey).toEqual({ pk: "x" });
	});
	it("touchKey writes at most once an hour per key, without throwing", async () => {
		ddb.send.mockReset().mockRejectedValue(new Error("boom"));
		const t = Date.parse("2026-10-22T10:00:00Z");
		touchKey("o", "k-touch", t); touchKey("o", "k-touch", t + 59 * 60_000); touchKey("o", "k-touch", t + 61 * 60_000);
		await new Promise((r) => setTimeout(r, 0));
		expect(ddb.send).toHaveBeenCalledTimes(2);
	});
	it("normalizes emails", () => expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com"));
});
