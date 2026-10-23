import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
const accounts = vi.hoisted(() => ({ getProfile: vi.fn() }));
vi.mock("../services/shared/accounts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../services/shared/accounts")>()), ...accounts }));
process.env.TENANTS_TABLE = "tenants";
process.env.QUOTAS_TABLE = "quotas";

const { FREE_LIMITS, legacyLimits } = await import("../services/shared/accounts");
const { PLANS } = await import("../services/billing/plans");
const { consumeCounter, consumeQuota, counterIds, readCounter, releaseQuota, secondsUntil, secondsUntilUtcMidnight, tenantForKey } = await import("../services/shared/tenants");

// A fresh key per test: tenantForKey caches by key hash for a minute.
const newApiKey = () => `tw_${randomBytes(32).toString("base64url")}`;
const row = { key_hash: "h", org_id: "o1", key_id: "k1", scope: "write", status: "active" };
const profile = { org_id: "o1", name: "Acme", status: "active", plan: "free", limits: FREE_LIMITS, rubric: null, evals_enabled: true };
const tenant = { tenant_id: "o1", org_id: "o1", name: "Acme", status: "active" as const, plan: "free", retention_days: 7, period_start: "2026-10-01", period_end: "2026-11-01", limits: FREE_LIMITS, rubric: null, evals_enabled: true };

const ccf = () => new ConditionalCheckFailedException({ message: "x", $metadata: {} });

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
	afterEach(() => vi.useRealTimers());
	it("stamps the plan, retention and period on the tenant", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-23T12:00:00Z"), toFake: ["Date"] });
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce({ ...profile, plan: "pro", limits: PLANS.pro.limits, period_start: "2026-10-15", period_end: "2026-11-15" });
		expect(await tenantForKey(newApiKey())).toMatchObject({ plan: "pro", retention_days: 90, period_start: "2026-10-15", period_end: "2026-11-15" });
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce(profile);
		expect(await tenantForKey(newApiKey())).toMatchObject({ plan: "free", retention_days: 7, period_start: "2026-10-01", period_end: "2026-11-01" });
	});
	it.each([["custom", undefined, 30], ["custom", 365, 365], ["team", undefined, 30]])("resolves %s retention %s to %s days", async (plan, days, want) => {
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce({ ...profile, plan, retention_days: days });
		expect((await tenantForKey(newApiKey()))!.retention_days).toBe(want);
	});
	it("fills a missing monthly_events from the plan: 50,000 for free, uncapped otherwise", async () => {
		const { monthly_events: _drop, ...old } = FREE_LIMITS;
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce({ ...profile, limits: old });
		expect((await tenantForKey(newApiKey()))!.limits.monthly_events).toBe(50_000);
		ddb.send.mockResolvedValueOnce({ Item: row });
		accounts.getProfile.mockResolvedValueOnce({ ...profile, plan: "team", limits: old });
		expect((await tenantForKey(newApiKey()))!.limits.monthly_events).toBeNull();
	});
	it("treats an old-shape row as custom with 30-day retention and a calendar-month period", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-23T12:00:00Z"), toFake: ["Date"] });
		accounts.getProfile.mockReset().mockResolvedValue(null);
		ddb.send.mockResolvedValueOnce({ Item: { key_hash: "h", tenant_id: "t1", name: "Demo", status: "active", events_per_minute: 6000 } });
		expect(await tenantForKey(newApiKey())).toMatchObject({ plan: "custom", retention_days: 30, period_start: "2026-10-01", period_end: "2026-11-01" });
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
	const sentUpdates = () => ddb.send.mock.calls.map((c) => c[0] as { input: Record<string, any> }).filter((c) => c.input.UpdateExpression);
	it("consumeQuota reports when the minute window refused, without touching the period counter", async () => {
		const t = { ...tenant, limits: { ...FREE_LIMITS, events_per_minute: 10 } };
		ddb.send.mockReset().mockRejectedValueOnce(ccf());
		expect(await consumeQuota(t, 5)).toBe("minute");
		expect(ddb.send).toHaveBeenCalledTimes(1);
		ddb.send.mockReset().mockResolvedValue({});
		expect(await consumeQuota(t, 5)).toBe("ok");
	});
	it("counts events per billing period and names the refusal by plan", async () => {
		const free = { ...tenant, plan: "free", limits: { ...PLANS.free.limits, monthly_events: 10 }, period_start: "2026-10-01", period_end: "2026-11-01" };
		ddb.send.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(ccf());
		expect(await consumeQuota(free, 5)).toBe("month");
		expect(sentUpdates()[1]!.input.Key).toEqual({ window: "o1#month#2026-10-01" });
		expect(sentUpdates()[1]!.input.ExpressionAttributeValues).toMatchObject({ ":n": 5, ":max": 5 });
		const team = { ...free, plan: "team", limits: { ...PLANS.team.limits, monthly_events: 900_000 } };
		ddb.send.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(ccf());
		expect(await consumeQuota(team, 5)).toBe("spend_cap");
	});
	it("expires the period counter 40 days after the period ends", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		await consumeQuota(tenant, 1);
		expect(sentUpdates()[1]!.input.ExpressionAttributeValues[":exp"]).toBe(Date.parse("2026-11-01") / 1000 + 40 * 86_400);
	});
	it("always counts paid usage even without a cap, so the meter can read it", async () => {
		const pro = { ...tenant, plan: "pro", limits: { ...PLANS.pro.limits, monthly_events: null } };
		ddb.send.mockReset().mockResolvedValue({});
		expect(await consumeQuota(pro, 5)).toBe("ok");
		expect(sentUpdates()).toHaveLength(2);
		expect(sentUpdates()[1]!.input.ExpressionAttributeValues[":max"]).toBe(Number.MAX_SAFE_INTEGER - 5);
	});
	it("starts a new counter when the period rolls over", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		await consumeQuota({ ...tenant, period_start: "2026-11-15", period_end: "2026-12-15" }, 1);
		expect(sentUpdates()[1]!.input.Key).toEqual({ window: "o1#month#2026-11-15" });
	});
	it("releases counted events after a failed enqueue", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		await releaseQuota(tenant, 5);
		const u = sentUpdates()[0]!.input;
		expect(u.Key).toEqual({ window: "o1#month#2026-10-01" });
		expect(u.UpdateExpression).toBe("ADD used :neg");
		expect(u.ExpressionAttributeValues).toEqual({ ":neg": -5 });
	});
	it("never throws from releaseQuota", async () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		ddb.send.mockReset().mockRejectedValueOnce(new Error("throttled"));
		await expect(releaseQuota(tenant, 5)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
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
	it("names counters by window", () => {
		const now = Date.parse("2026-10-22T23:59:00Z");
		expect(counterIds.period("o", "2026-10-15")).toBe("o#month#2026-10-15");
		expect("day" in counterIds).toBe(false);
		expect(counterIds.athena("o", now)).toBe("o#athena#2026-10-22");
		expect(counterIds.evals("o", "2026-10-22")).toBe("o#evals#2026-10-22");
		expect(counterIds.minute("o", now)).toBe(`o#${Math.floor(now / 60_000)}`);
		expect(counterIds.globalOrgs(Date.parse("2026-10-22T01:00:00Z"))).toBe("global#orgs#2026-10-22");
	});
	it("counts seconds until a date, never negative", () => {
		expect(secondsUntil("2026-11-01", Date.parse("2026-10-31T23:00:00Z"))).toBe(3600);
		expect(secondsUntil("2026-11-01", Date.parse("2026-11-02T00:00:00Z"))).toBe(0);
	});
	it("counts seconds to UTC midnight", () => expect(secondsUntilUtcMidnight(Date.parse("2026-10-22T23:59:00Z"))).toBe(60));
});
