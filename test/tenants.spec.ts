import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
const accounts = vi.hoisted(() => ({ getProfile: vi.fn() }));
vi.mock("../services/shared/accounts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../services/shared/accounts")>()), ...accounts }));
process.env.TENANTS_TABLE = "tenants";
process.env.QUOTAS_TABLE = "quotas";

const { FREE_LIMITS, legacyLimits } = await import("../services/shared/accounts");
const { consumeCounter, consumeQuota, counterIds, readCounter, secondsUntilUtcMidnight, tenantForKey } = await import("../services/shared/tenants");

// A fresh key per test: tenantForKey caches by key hash for a minute.
const newApiKey = () => `tw_${randomBytes(32).toString("base64url")}`;
const row = { key_hash: "h", org_id: "o1", key_id: "k1", scope: "write", status: "active" };
const profile = { org_id: "o1", name: "Acme", status: "active", limits: FREE_LIMITS, rubric: null, evals_enabled: true };
const tenant = { tenant_id: "o1", org_id: "o1", name: "Acme", status: "active" as const, limits: FREE_LIMITS, rubric: null, evals_enabled: true };

const refused = () => new ConditionalCheckFailedException({ message: "x", $metadata: {} });

describe("tenantForKey", () => {
	it("resolves a new-shape key row through the org profile", async () => {
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce(profile);
		expect(await tenantForKey(newApiKey())).toMatchObject({ tenant_id: "o1", org_id: "o1", key_id: "k1", scope: "write", name: "Acme", limits: FREE_LIMITS });
	});
	it.each([
		["revoked key", { status: "revoked" }, { status: "active" }],
		["suspended org", {}, { status: "suspended" }],
		["deleting org", {}, { status: "deleting" }],
	])("returns null for a %s", async (_n, r, p) => {
		// A revoked key short-circuits before the profile read, so drop any unconsumed value.
		accounts.getProfile.mockReset();
		ddb.send.mockResolvedValueOnce({ Item: { ...row, ...r } });
		accounts.getProfile.mockResolvedValueOnce({ ...profile, ...p });
		expect(await tenantForKey(newApiKey())).toBeNull();
	});
	it("returns null for an unknown key or a missing profile", async () => {
		ddb.send.mockResolvedValueOnce({ Item: undefined });
		expect(await tenantForKey(newApiKey())).toBeNull();
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce(null);
		expect(await tenantForKey(newApiKey())).toBeNull();
	});
	const legacyRow = { key_hash: "h", tenant_id: "t1", name: "Demo", status: "active", events_per_minute: 6000, scope: "read" };
	it("falls back to an old-shape row that has no org_id and no profile yet", async () => {
		accounts.getProfile.mockReset().mockResolvedValue(null);
		ddb.send.mockResolvedValueOnce({ Item: legacyRow });
		expect(await tenantForKey(newApiKey())).toMatchObject({ tenant_id: "t1", org_id: "t1", scope: "read", name: "Demo", limits: legacyLimits(6000) });
		expect(accounts.getProfile).toHaveBeenCalledWith("t1");
	});
	it("serves an old-shape row whose org has an active profile, built from the row", async () => {
		accounts.getProfile.mockReset().mockResolvedValue({ ...profile, org_id: "t1" });
		ddb.send.mockResolvedValueOnce({ Item: legacyRow });
		expect(await tenantForKey(newApiKey())).toMatchObject({ tenant_id: "t1", name: "Demo", limits: legacyLimits(6000) });
	});
	it.each(["deleted", "deleting", "suspended"])("refuses an old-shape row whose org is %s", async (status) => {
		accounts.getProfile.mockReset().mockResolvedValue({ ...profile, org_id: "t1", status });
		ddb.send.mockResolvedValueOnce({ Item: legacyRow });
		expect(await tenantForKey(newApiKey())).toBeNull();
	});
	it("caches the result per key for a minute", async () => {
		const key = newApiKey();
		ddb.send.mockClear().mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce(profile);
		await tenantForKey(key);
		await tenantForKey(key);
		expect(ddb.send).toHaveBeenCalledTimes(1);
	});
});

describe("counters and quota", () => {
	it("consumeQuota reports which window refused", async () => {
		const t = { ...tenant, limits: { ...FREE_LIMITS, events_per_minute: 10, events_per_day: 15 } };
		ddb.send.mockResolvedValueOnce({}).mockRejectedValueOnce(refused());
		expect(await consumeQuota(t, 5)).toBe("day");
		ddb.send.mockRejectedValueOnce(refused());
		expect(await consumeQuota(t, 5)).toBe("minute");
		ddb.send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
		expect(await consumeQuota(t, 5)).toBe("ok");
	});
	it("consumeCounter propagates errors that are not a refusal", async () => {
		ddb.send.mockRejectedValueOnce(new Error("boom"));
		await expect(consumeCounter("o#x", 1, 10, 100)).rejects.toThrow("boom");
	});
	it("readCounter returns used, or 0 when there is no row", async () => {
		ddb.send.mockResolvedValueOnce({ Item: { used: 7 } });
		expect(await readCounter("o#x")).toBe(7);
		ddb.send.mockResolvedValueOnce({});
		expect(await readCounter("o#x")).toBe(0);
	});
	it("names counters by day in UTC", () => {
		const now = Date.parse("2026-10-22T23:59:00Z");
		expect(counterIds.day("o", now)).toBe("o#day#2026-10-22");
		expect(counterIds.athena("o", now)).toBe("o#athena#2026-10-22");
		expect(counterIds.evals("o", "2026-10-22")).toBe("o#evals#2026-10-22");
		expect(counterIds.minute("o", now)).toBe(`o#${Math.floor(now / 60_000)}`);
		expect(counterIds.globalOrgs(Date.parse("2026-10-22T01:00:00Z"))).toBe("global#orgs#2026-10-22");
	});
	it("counts seconds to UTC midnight", () => expect(secondsUntilUtcMidnight(Date.parse("2026-10-22T23:59:00Z"))).toBe(60));
});
