import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
process.env.ACCOUNTS_TABLE = "accounts";
process.env.TENANTS_TABLE = "tenants";

const { applyPlan, planMigration, scanKeyIndex, scanProfileIds } = await import("../scripts/lib/migrate");
const { parseLimitOverrides } = await import("../scripts/lib/limits");
type LegacyRow = import("../scripts/lib/migrate").LegacyRow;

const demo: LegacyRow = { key_hash: "a".repeat(64), tenant_id: "t1", name: "Acme Support", status: "active", events_per_minute: 6000, scope: "read", created_at: "2026-10-01T00:00:00Z" };
const write: LegacyRow = { ...demo, key_hash: "b".repeat(64), scope: undefined };
const now = "2026-10-22T10:00:00.000Z";

describe("planMigration", () => {
	it("creates one profile per tenant that keeps the demo and load test working", () => {
		const p = planMigration([demo, write], new Set());
		expect(p.profiles).toHaveLength(1);
		expect(p.profiles[0]).toMatchObject({ org_id: "t1", plan: "custom", owner_count: 0, limits: { events_per_minute: 6000, events_per_day: 8_640_000, analytics_queries_per_day: 10_000 } });
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
	const plan = () => planMigration([demo, write], new Set(), { sub: "u1", email: "z@x.io" }, now);

	it("writes the profile with its member and reverse USER row together, then each key, then its index row", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		const counts = await applyPlan(plan());
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
		expect(puts[1]).toMatchObject({ ConditionExpression: "attribute_not_exists(org_id)", Item: { key_hash: demo.key_hash, org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", scope: "read", status: "active" } });
		expect(counts).toEqual({ profiles: 1, members: 1, keys: 2, index: 2 });
	});

	it("writes no member or USER item without an owner", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		await applyPlan(planMigration([demo], new Set()));
		expect(calls(TransactWriteCommand)[0]!.input.TransactItems).toHaveLength(1);
	});

	it("a re-run over rows that are already done changes nothing: condition failures are skipped", async () => {
		ddb.send.mockReset().mockImplementation(async (cmd: object) => {
			if (cmd instanceof TransactWriteCommand) throw cancelled("ConditionalCheckFailed", "None", "None");
			throw condFail();
		});
		const counts = await applyPlan(plan());
		expect(counts).toEqual({ profiles: 0, members: 0, keys: 0, index: 0 });
		// The keys are still attempted after a profile that already exists.
		expect(calls(PutCommand)).toHaveLength(4);
	});

	it("repairs a half-finished run: KEY item exists but the index row still has the old shape", async () => {
		ddb.send.mockReset().mockImplementation(async (cmd: object) => {
			if (cmd instanceof PutCommand && cmd.input.TableName === "accounts") throw condFail();
			return {};
		});
		const counts = await applyPlan(planMigration([demo], new Set(["t1"])));
		expect(counts).toEqual({ profiles: 0, members: 0, keys: 0, index: 1 });
	});

	it("does not swallow real errors", async () => {
		ddb.send.mockReset().mockRejectedValue(new Error("throttled"));
		await expect(applyPlan(plan())).rejects.toThrow("throttled");
		ddb.send.mockReset().mockRejectedValue(cancelled("ThrottlingError"));
		await expect(applyPlan(plan())).rejects.toThrow();
	});

	it("writes nothing for an empty plan", async () => {
		ddb.send.mockReset().mockResolvedValue({});
		expect(await applyPlan(planMigration([], new Set()))).toEqual({ profiles: 0, members: 0, keys: 0, index: 0 });
		expect(ddb.send).not.toHaveBeenCalled();
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

	it("scanProfileIds collects org ids of every PROFILE, whatever its status", async () => {
		ddb.send.mockReset()
			.mockResolvedValueOnce({ Items: [{ org_id: "t1" }], LastEvaluatedKey: { pk: "p" } })
			.mockResolvedValueOnce({ Items: [{ org_id: "t2" }] });
		expect(await scanProfileIds()).toEqual(new Set(["t1", "t2"]));
		expect(calls(ScanCommand)[0]!.input).toMatchObject({ TableName: "accounts", FilterExpression: "sk = :p", ExpressionAttributeValues: { ":p": "PROFILE" } });
	});
});

describe("parseLimitOverrides", () => {
	const current = { events_per_minute: 600, events_per_day: 50_000, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 10, max_members: 5, max_pending_invites: 10 };

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

	it("does not inherit prototype keys", () => {
		expect(() => parseLimitOverrides(["constructor=1"], current)).toThrow(/unknown limit/);
	});
});
