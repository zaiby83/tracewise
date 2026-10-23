import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
process.env.ACCOUNTS_TABLE = "accounts";
process.env.TENANTS_TABLE = "tenants";

const { applyPlan, planMigration, scanKeyIndex, scanProfiles } = await import("../scripts/lib/migrate");
const { parseLimitOverrides } = await import("../scripts/lib/limits");
type LegacyRow = import("../scripts/lib/migrate").LegacyRow;
type ExistingProfile = import("../scripts/lib/migrate").ExistingProfile;

const demo: LegacyRow = { key_hash: "a".repeat(64), tenant_id: "t1", name: "Acme Support", status: "active", events_per_minute: 6000, scope: "read", created_at: "2026-10-01T00:00:00Z" };
const write: LegacyRow = { ...demo, key_hash: "b".repeat(64), scope: undefined };
const now = "2026-10-22T10:00:00.000Z";

describe("planMigration", () => {
	it("creates one profile per tenant that keeps the demo and load test working", () => {
		const p = planMigration([demo, write], new Set());
		expect(p.profiles).toHaveLength(1);
		expect(p.profiles[0]).toMatchObject({ org_id: "t1", plan: "custom", owner_count: 0, limits: { events_per_minute: 6000, monthly_events: null, analytics_queries_per_day: 10_000, max_keys: 10, max_members: 5, max_pending_invites: 10 } });
		expect(p.index).toEqual([
			{ key_hash: demo.key_hash, org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", scope: "read", status: "active" },
			{ key_hash: write.key_hash, org_id: "t1", key_id: "bbbbbbbbbbbbbbbb", scope: "write", status: "active" },
		]);
	});

	it("is idempotent", () => {
		const once = planMigration([demo], new Set());
		const migrated = { ...demo, org_id: "t1" };
		expect(planMigration([migrated], new Set(["t1"]))).toEqual({ profiles: [], members: [], keys: [], index: [] });
		expect(planMigration([demo], new Set(["t1"])).keys).toEqual(once.keys);
	});

	it("attaches an owner when given one", () => {
		const p = planMigration([demo], new Set(), { sub: "u1", email: "z@x.io" });
		expect(p.members).toEqual([expect.objectContaining({ org_id: "t1", sub: "u1", role: "owner" })]);
		expect(p.profiles[0]!.owner_count).toBe(1);
	});

	it("builds a KEY record for every legacy row, with stable ids and the row's own timestamps", () => {
		const p = planMigration([demo, write], new Set(), undefined, now);
		expect(p.keys).toEqual([
			{ org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", name: "Legacy read key", scope: "read", prefix: "tw_••••••", key_hash: demo.key_hash, created_by: "operator", created_at: demo.created_at },
			{ org_id: "t1", key_id: "bbbbbbbbbbbbbbbb", name: "Legacy key", scope: "write", prefix: "tw_••••••", key_hash: write.key_hash, created_by: "operator", created_at: write.created_at },
		]);
		expect(p.index).toHaveLength(p.keys.length);
	});

	it("takes the profile from the tenant's rows: name, rubric, and the earliest creation time", () => {
		const later = { ...demo, key_hash: "c".repeat(64), name: "other", rubric: "be strict", created_at: "2026-10-05T00:00:00Z" };
		const earlier = { ...demo, key_hash: "d".repeat(64), created_at: "2026-09-01T00:00:00Z" };
		const [profile] = planMigration([later, earlier], new Set()).profiles;
		expect(profile).toMatchObject({ name: "other", rubric: "be strict", created_at: "2026-09-01T00:00:00Z", created_by: "operator", status: "active", evals_enabled: true });
		expect(planMigration([demo], new Set()).profiles[0]!.rubric).toBeNull();
	});

	it("plans separate profiles for separate tenants, and only the new ones", () => {
		const other = { ...demo, key_hash: "e".repeat(64), tenant_id: "t2", events_per_minute: 100 };
		const p = planMigration([demo, other], new Set(["t1"]), { sub: "u1", email: "Z@X.io" });
		expect(p.profiles.map((x) => x.org_id)).toEqual(["t2"]);
		expect(p.profiles[0]!.limits.events_per_minute).toBe(100);
		// An owner is attached only to orgs this run creates, so owner_count never double counts.
		expect(p.members).toEqual([expect.objectContaining({ org_id: "t2", email: "z@x.io", joined_at: expect.any(String) })]);
		// Keys are still planned for the tenant that already has a profile (an interrupted earlier run).
		expect(p.keys.map((x) => x.org_id).sort()).toEqual(["t1", "t2"]);
	});

	it("skips rows that already have an org_id, and carries revoked keys over as revoked", () => {
		const revoked = { ...write, status: "revoked" };
		const p = planMigration([{ ...demo, org_id: "t1" }, revoked], new Set(["t1"]), undefined, now);
		expect(p.index).toEqual([{ key_hash: write.key_hash, org_id: "t1", key_id: "bbbbbbbbbbbbbbbb", scope: "write", status: "revoked" }]);
		expect(p.keys[0]!.revoked_at).toBe(now);
		// Anything that is not plainly active fails closed.
		expect(planMigration([{ ...demo, status: "paused" }], new Set()).index[0]!.status).toBe("revoked");
	});

	it("never mutates its input", () => {
		const rows = [demo, write];
		const copy = structuredClone(rows);
		planMigration(rows, new Set());
		expect(rows).toEqual(copy);
	});
});

const cancelled = (...codes: string[]) => new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
const condFail = () => new ConditionalCheckFailedException({ message: "x", $metadata: {} });
const calls = <T extends object>(cmd: new (...a: never[]) => T) => ddb.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cmd);

describe("applyPlan", () => {
	const rows = [demo, write];
	const plan = () => planMigration(rows, new Set(), { sub: "u1", email: "z@x.io" }, now);
	const scan = { rows, profiles: new Map<string, ExistingProfile>() };

	it("writes the profile with its member and reverse USER row together, then each key, then its index row", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		const counts = await applyPlan(plan(), scan);
		const order = ddb.send.mock.calls.map((c) => c[0].constructor.name);
		expect(order).toEqual(["TransactWriteCommand", "PutCommand", "PutCommand", "PutCommand", "PutCommand"]);

		const items = calls(TransactWriteCommand)[0]!.input.TransactItems!;
		expect(items.map((i) => (i.Put!.Item as Record<string, string>).sk)).toEqual(["PROFILE", "MEMBER#u1", "ORG#t1"]);
		expect(items[0]!.Put).toMatchObject({ TableName: "accounts", ConditionExpression: "attribute_not_exists(pk)" });
		expect(items[2]!.Put!.Item).toEqual({ pk: "USER#u1", sk: "ORG#t1", role: "owner", org_name: "Acme Support" });

		const puts = calls(PutCommand).map((c) => c.input);
		// KEY item before its index row, so an index row never exists without its KEY item.
		expect(puts.map((p) => [p.TableName, (p.Item as Record<string, string>).sk ?? "index"])).toEqual([
			["accounts", "KEY#aaaaaaaaaaaaaaaa"], ["tenants", "index"], ["accounts", "KEY#bbbbbbbbbbbbbbbb"], ["tenants", "index"],
		]);
		expect(puts[0]).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)" });
		expect(puts[0]!.Item).toMatchObject({ pk: "ORG#t1", org_id: "t1", key_id: "aaaaaaaaaaaaaaaa" });
		expect(puts[1]).toMatchObject({ ConditionExpression: "attribute_not_exists(org_id) AND #s = :scanned", ExpressionAttributeValues: { ":scanned": "active" }, Item: { key_hash: demo.key_hash, org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", scope: "read", status: "active" } });
		expect(counts).toEqual({ profiles: 1, members: 1, keys: 2, index: 2, retired: 0, stale: 0 });
	});

	it("writes no member or USER item without an owner", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		await applyPlan(planMigration([demo], new Set()), { rows: [demo], profiles: new Map() });
		expect(calls(TransactWriteCommand)[0]!.input.TransactItems).toHaveLength(1);
	});

	it("a re-run over rows that are already done changes nothing: condition failures are skipped", async () => {
		ddb.send.mockReset().mockImplementation(async (cmd: object) => {
			if (cmd instanceof TransactWriteCommand) throw cancelled("ConditionalCheckFailed", "None", "None");
			throw condFail();
		});
		const counts = await applyPlan(plan(), scan);
		// Nothing written; the index rows count as stale because every condition failed here.
		expect(counts).toEqual({ profiles: 0, members: 0, keys: 0, index: 0, retired: 0, stale: 2 });
		// The keys are still attempted after a profile that already exists.
		expect(calls(PutCommand)).toHaveLength(4);
	});

	it("repairs a half-finished run: KEY item exists but the index row still has the old shape", async () => {
		ddb.send.mockReset().mockImplementation(async (cmd: object) => {
			if (cmd instanceof PutCommand && cmd.input.TableName === "accounts") throw condFail();
			return {};
		});
		const counts = await applyPlan(planMigration([demo], new Set(["t1"])), { rows: [demo], profiles: new Map() });
		expect(counts).toEqual({ profiles: 0, members: 0, keys: 0, index: 1, retired: 0, stale: 0 });
	});

	it("does not swallow real errors", async () => {
		ddb.send.mockReset().mockRejectedValue(new Error("throttled"));
		await expect(applyPlan(plan(), scan)).rejects.toThrow("throttled");
		ddb.send.mockReset().mockRejectedValue(cancelled("ThrottlingError"));
		await expect(applyPlan(plan(), scan)).rejects.toThrow();
	});

	it("writes nothing for an empty plan", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		expect(await applyPlan(planMigration([], new Set()), { rows: [], profiles: new Map() })).toEqual({ profiles: 0, members: 0, keys: 0, index: 0, retired: 0, stale: 0 });
		expect(ddb.send).not.toHaveBeenCalled();
	});
});

const owner = { sub: "u1", email: "z@x.io" };
const info = (status: ExistingProfile["status"], owner_count: number): ExistingProfile => ({ name: "Acme Support", status, owner_count });

describe("planMigration with scanned profiles", () => {
	it("attaches the owner to an active profile that has none, and to nothing else", () => {
		const profiles = new Map([["t1", info("active", 0)], ["t2", info("active", 1)], ["t3", info("suspended", 0)], ["t4", info("deleted", 0)]]);
		const p = planMigration([], profiles, owner, now);
		expect(p.profiles).toEqual([]);
		expect(p.members).toEqual([{ org_id: "t1", sub: "u1", email: "z@x.io", role: "owner", joined_at: now }]);
	});

	it("plans nothing for a bare Set, and nothing without an owner", () => {
		expect(planMigration([], new Set(["t1"]), owner).members).toEqual([]);
		expect(planMigration([], new Map([["t1", info("active", 0)]])).members).toEqual([]);
	});

	it("retires rows of orgs that are not active: a revoked lean row, no KEY item", () => {
		const rows = [demo, { ...demo, key_hash: "f".repeat(64), tenant_id: "t9", scope: undefined }];
		const profiles = new Map([["t1", info("deleted", 0)], ["t9", info("active", 1)]]);
		const p = planMigration(rows, profiles, owner);
		expect(p.keys.map((x) => x.org_id)).toEqual(["t9"]);
		expect(p.index).toEqual([
			{ key_hash: demo.key_hash, org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", scope: "read", status: "revoked" },
			{ key_hash: "f".repeat(64), org_id: "t9", key_id: "ffffffffffffffff", scope: "write", status: "active" },
		]);
		for (const status of ["deleting", "deleted", "suspended"] as const) {
			const q = planMigration([demo], new Map([["t1", info(status, 0)]]));
			expect(q).toEqual({ profiles: [], members: [], keys: [], index: [expect.objectContaining({ org_id: "t1", status: "revoked" })] });
		}
	});
});

describe("applyPlan, owner attach and stale rows", () => {
	it("attaches an owner to an existing profile in one transaction guarded on owner_count 0 and active", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		const profiles = new Map([["t1", info("active", 0)]]);
		const counts = await applyPlan(planMigration([], profiles, owner, now), { rows: [], profiles });
		expect(counts.members).toBe(1);
		const items = calls(TransactWriteCommand)[0]!.input.TransactItems!;
		expect(items).toHaveLength(3);
		expect(items[0]!.Put).toMatchObject({ ConditionExpression: "attribute_not_exists(pk)", Item: { pk: "ORG#t1", sk: "MEMBER#u1", role: "owner" } });
		expect(items[1]!.Put!.Item).toEqual({ pk: "USER#u1", sk: "ORG#t1", role: "owner", org_name: "Acme Support" });
		expect(items[2]!.Update).toMatchObject({
			Key: { pk: "ORG#t1", sk: "PROFILE" },
			UpdateExpression: "SET owner_count = owner_count + :one",
			ConditionExpression: "owner_count = :zero AND #s = :active",
			ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":active": "active" },
		});
	});

	it("treats a failed owner-attach condition as already done", async () => {
		ddb.send.mockReset().mockRejectedValue(cancelled("None", "None", "ConditionalCheckFailed"));
		const profiles = new Map([["t1", info("active", 0)]]);
		expect((await applyPlan(planMigration([], profiles, owner, now), { rows: [], profiles })).members).toBe(0);
	});

	it("skips, without throwing, an index row whose status changed since the scan", async () => {
		ddb.send.mockReset().mockImplementation(async (cmd: object) => {
			if (cmd instanceof PutCommand && cmd.input.TableName === "tenants") throw condFail();
			return {};
		});
		const counts = await applyPlan(planMigration([demo], new Set(["t1"])), { rows: [demo], profiles: new Map() });
		expect(counts).toEqual({ profiles: 0, members: 0, keys: 1, index: 0, retired: 0, stale: 1 });
	});

	it("guards the rewrite with the raw scanned status, not the mapped one", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		const paused = { ...demo, status: "paused" };
		await applyPlan(planMigration([paused], new Set(["t1"])), { rows: [paused], profiles: new Map() });
		const index = calls(PutCommand).map((c) => c.input).find((i) => i.TableName === "tenants")!;
		expect(index.ExpressionAttributeValues).toEqual({ ":scanned": "paused" });
		expect(index.Item).toMatchObject({ status: "revoked" });
	});
});

// A small in-memory table pair that honours exactly the conditions the migration writes,
// to show the whole thing converges: run, run with an owner, run again.
function fakeAws() {
	const db = new Map<string, Record<string, any>>();
	const id = (t: string, i: Record<string, any>) => `${t}|${i.pk ?? i.key_hash}|${i.sk ?? ""}`;
	for (const row of [demo, write]) db.set(id("tenants", row), { ...row });
	const fail = () => cancelled("ConditionalCheckFailed");
	const put = (input: any) => {
		const old = db.get(id(input.TableName, input.Item));
		const cond = input.ConditionExpression;
		if (cond === "attribute_not_exists(pk)" && old) throw fail();
		if (cond?.startsWith("attribute_not_exists(org_id)") && old && (old.org_id || old.status !== input.ExpressionAttributeValues[":scanned"])) throw fail();
		db.set(id(input.TableName, input.Item), { ...input.Item });
	};
	ddb.send.mockReset().mockImplementation(async (cmd: any) => {
		if (cmd instanceof PutCommand) return put(cmd.input);
		if (cmd instanceof TransactWriteCommand) {
			const staged = new Map(db);
			try {
				for (const t of cmd.input.TransactItems!) {
					if (t.Put) put(t.Put);
					if (t.Update) {
						const p = db.get(id("accounts", t.Update.Key!));
						if (!p || p.owner_count !== 0 || p.status !== "active") throw fail();
						p.owner_count += 1;
					}
				}
			} catch (e) {
				db.clear();
				for (const [key, v] of staged) db.set(key, v);
				throw e;
			}
			return {};
		}
		if (cmd instanceof ScanCommand) {
			const table = cmd.input.TableName!;
			return { Items: [...db].filter(([key]) => key.startsWith(`${table}|`)).map(([, v]) => v).filter((v) => table === "tenants" || v.sk === "PROFILE") };
		}
		throw new Error("unexpected command");
	});
	return db;
}

describe("a full migration, run three times", () => {
	const run = async (who?: { sub: string; email: string }) => {
		const rows = await scanKeyIndex();
		const profiles = await scanProfiles();
		return applyPlan(planMigration(rows, profiles, who, now), { rows, profiles });
	};

	it("migrates without an owner, attaches one on the second run, and the third changes nothing", async () => {
		const db = fakeAws();
		expect(await run()).toEqual({ profiles: 1, members: 0, keys: 2, index: 2, retired: 0, stale: 0 });
		expect(db.get("accounts|ORG#t1|PROFILE")!.owner_count).toBe(0);
		expect([...db.keys()].filter((key) => key.startsWith("accounts|ORG#t1|KEY#"))).toHaveLength(2);
		for (const row of [demo, write]) expect(db.get(`tenants|${row.key_hash}|`)).toMatchObject({ org_id: "t1" });

		expect(await run(owner)).toEqual({ profiles: 0, members: 1, keys: 0, index: 0, retired: 0, stale: 0 });
		expect(db.get("accounts|ORG#t1|PROFILE")!.owner_count).toBe(1);
		expect(db.get("accounts|ORG#t1|MEMBER#u1")).toMatchObject({ role: "owner" });
		expect(db.get("accounts|USER#u1|ORG#t1")).toMatchObject({ role: "owner", org_name: "Acme Support" });

		const before = structuredClone([...db]);
		expect(await run(owner)).toEqual({ profiles: 0, members: 0, keys: 0, index: 0, retired: 0, stale: 0 });
		expect([...db]).toEqual(before);
	});

	it("retires the keys of an org that is deleting: revoked lean rows, no KEY item", async () => {
		const db = fakeAws();
		db.set("accounts|ORG#t1|PROFILE", { pk: "ORG#t1", sk: "PROFILE", org_id: "t1", name: "Acme Support", status: "deleting", owner_count: 0 });
		expect(await run(owner)).toEqual({ profiles: 0, members: 0, keys: 0, index: 0, retired: 2, stale: 0 });
		for (const row of [demo, write]) expect(db.get(`tenants|${row.key_hash}|`)).toMatchObject({ org_id: "t1", status: "revoked" });
		expect([...db.keys()].some((key) => key.includes("KEY#"))).toBe(false);
		// Nothing is left in the old shape, so a re-run has nothing to do.
		expect(await run(owner)).toEqual({ profiles: 0, members: 0, keys: 0, index: 0, retired: 0, stale: 0 });
	});
});

describe("scans", () => {
	it("scanKeyIndex follows pagination", async () => {
		ddb.send.mockReset()
			.mockResolvedValueOnce({ Items: [demo], LastEvaluatedKey: { key_hash: "x" } })
			.mockResolvedValueOnce({ Items: [write] });
		expect(await scanKeyIndex()).toEqual([demo, write]);
		const scans = calls(ScanCommand);
		expect(scans.map((s) => s.input.TableName)).toEqual(["tenants", "tenants"]);
		expect(scans[1]!.input.ExclusiveStartKey).toEqual({ key_hash: "x" });
	});

	it("scanProfiles reads status, name and owner count of every PROFILE, whatever its status", async () => {
		ddb.send.mockReset()
			.mockResolvedValueOnce({ Items: [{ org_id: "t1", name: "A", status: "active", owner_count: 2 }], LastEvaluatedKey: { pk: "p" } })
			.mockResolvedValueOnce({ Items: [{ org_id: "t2", name: "B", status: "deleted" }] });
		expect(await scanProfiles()).toEqual(new Map([
			["t1", { name: "A", status: "active", owner_count: 2 }],
			["t2", { name: "B", status: "deleted", owner_count: 0 }],
		]));
		expect(calls(ScanCommand)[0]!.input).toMatchObject({ TableName: "accounts", FilterExpression: "sk = :p", ExpressionAttributeValues: { ":p": "PROFILE" } });
	});
});

describe("parseLimitOverrides", () => {
	const current = { events_per_minute: 600, monthly_events: 50_000 as number | null, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 10, max_members: 5, max_pending_invites: 10 };

	it("overrides the named limits and keeps the rest", () => {
		expect(parseLimitOverrides(["events_per_minute=1200", "max_keys=25"], current)).toEqual({ ...current, events_per_minute: 1200, max_keys: 25 });
	});

	it("rejects unknown keys, malformed pairs and bad numbers", () => {
		expect(() => parseLimitOverrides(["bogus=1"], current)).toThrow(/unknown limit "bogus"/);
		expect(() => parseLimitOverrides(["max_keys"], current)).toThrow(/key=value/);
		expect(() => parseLimitOverrides(["max_keys=-1"], current)).toThrow(/non-negative integer/);
		expect(() => parseLimitOverrides(["max_keys=1.5"], current)).toThrow(/non-negative integer/);
		expect(() => parseLimitOverrides(["max_keys=abc"], current)).toThrow(/non-negative integer/);
		expect(() => parseLimitOverrides(["max_keys="], current)).toThrow(/non-negative integer/);
		expect(() => parseLimitOverrides([], current)).toThrow(/at least one/);
	});

	it("accepts the literal null (and a number) for monthly_events only", () => {
		expect(parseLimitOverrides(["monthly_events=null"], current).monthly_events).toBeNull();
		expect(parseLimitOverrides(["monthly_events=1000"], current).monthly_events).toBe(1000);
		expect(() => parseLimitOverrides(["monthly_events=abc"], current)).toThrow(/non-negative integer or null/);
		expect(() => parseLimitOverrides(["max_keys=null"], current)).toThrow(/non-negative integer/);
	});

	it("does not inherit prototype keys", () => {
		expect(() => parseLimitOverrides(["constructor=1"], current)).toThrow(/unknown limit/);
	});
});
