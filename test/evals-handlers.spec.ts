import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SNSClient } from "@aws-sdk/client-sns";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_LIMITS } from "../services/shared/accounts";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
Object.assign(process.env, {
	ACCOUNTS_TABLE: "accounts",
	TENANTS_TABLE: "tenants",
	QUOTAS_TABLE: "quotas",
	TRACES_TABLE: "traces",
	EVALS_TABLE: "evals",
	JUDGE_MODEL: "judge",
});

const { listTenants, sample, record } = await import("../services/evals/handlers");

const cwSend = vi.spyOn(CloudWatchClient.prototype, "send");
const snsSend = vi.spyOn(SNSClient.prototype, "send");
const sent = <T>(ctor: new (...a: never[]) => T) => ddb.send.mock.calls.map((c) => c[0]).filter((c) => c instanceof ctor) as T[];
const metric = () => cwSend.mock.calls.map((c) => c[0]).find((c) => c instanceof PutMetricDataCommand)?.input;

const profile = (org_id: string, extra: Record<string, unknown> = {}) => ({
	pk: `ORG#${org_id}`,
	sk: "PROFILE",
	org_id,
	name: org_id.toUpperCase(),
	status: "active",
	limits: FREE_LIMITS,
	rubric: null,
	evals_enabled: true,
	...extra,
});

// Answers the Accounts scan and the key-index scan separately.
const scans = (accounts: unknown[], keys: unknown[] = []) =>
	ddb.send.mockImplementation(async (c) => {
		if (c instanceof ScanCommand) return { Items: c.input.TableName === "accounts" ? accounts : keys };
		return {};
	});

beforeEach(() => {
	ddb.send.mockReset();
	cwSend.mockReset().mockResolvedValue({} as never);
	snsSend.mockReset().mockResolvedValue({} as never);
});
afterEach(() => vi.useRealTimers());

describe("listTenants", () => {
	it("evaluates active orgs with evals on, leaving rubrics out of the state", async () => {
		scans([profile("a", { rubric: "r" }), profile("b", { evals_enabled: false })]);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants).toEqual([{ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 20, sample_limit: 20 }]);
		expect(metric()).toBeUndefined();
	});

	it("keeps a legacy row's own rubric on its ref", async () => {
		scans([], [{ tenant_id: "t", name: "Old", status: "active", events_per_minute: 600, rubric: "legacy" }]);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants[0]).toMatchObject({ tenant_id: "t", rubric: "legacy" });
	});

	it("still evaluates tenants that haven't been migrated", async () => {
		scans([], [{ tenant_id: "t", name: "Old", status: "active", events_per_minute: 6000 }]);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants).toEqual([{ tenant_id: "t", name: "Old", rubric: null, day: "2026-10-21", sample_budget: 20, sample_limit: 20 }]);
	});

	it("lists a legacy tenant once, and skips key rows that an org or profile already covers", async () => {
		scans(
			[profile("a")],
			[
				{ tenant_id: "t", name: "Old", status: "active", events_per_minute: 600, scope: "write" },
				{ tenant_id: "t", name: "Old", status: "active", events_per_minute: 600, scope: "read" },
				{ tenant_id: "a", name: "A", status: "active", events_per_minute: 600 },
				{ key_hash: "h", org_id: "a", tenant_id: "a", status: "active" },
				{ tenant_id: "off", name: "Off", status: "disabled", events_per_minute: 600 },
			],
		);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants.map((t) => t.tenant_id)).toEqual(["a", "t"]);
	});

	it("never evaluates an old key row of an org whose profile isn't active", async () => {
		scans(
			[profile("del", { status: "deleting" }), profile("gone", { status: "deleted" }), profile("sus", { status: "suspended" }), profile("a")],
			[
				{ tenant_id: "del", name: "Del", status: "active", events_per_minute: 600 },
				{ tenant_id: "gone", name: "Gone", status: "active", events_per_minute: 600 },
				{ tenant_id: "sus", name: "Sus", status: "active", events_per_minute: 600 },
				{ tenant_id: "t", name: "Old", status: "active", events_per_minute: 600 },
			],
		);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants.map((t) => t.tenant_id)).toEqual(["a", "t"]);
		// Every profile is read, whatever its status, so the old rows above can be recognised.
		const accountsScan = sent(ScanCommand).find((c) => c.input.TableName === "accounts")!;
		expect(JSON.stringify(accountsScan.input)).not.toContain("active");
	});

	it("splits 2,000 judge calls across orgs and reports the cap", async () => {
		scans(Array.from({ length: 150 }, (_, i) => profile(`o${i}`)));
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants).toHaveLength(150);
		expect(tenants.every((t) => t.sample_budget === 13 && t.sample_limit === 20)).toBe(true);
		expect(metric()).toMatchObject({
			Namespace: "Tracewise/Limits",
			MetricData: [{ MetricName: "GlobalCapHit", Dimensions: [{ Name: "Cap", Value: "judge" }], Value: 1 }],
		});
	});

	it("gives an org its full limit when the share is larger", async () => {
		scans(Array.from({ length: 100 }, (_, i) => profile(`o${i}`)));
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants.every((t) => t.sample_budget === 20)).toBe(true);
		expect(metric()).toBeUndefined();
	});

	it("handles no tenants at all", async () => {
		scans([]);
		expect(await listTenants({ day: "2026-10-21" })).toEqual({ tenants: [] });
		expect(metric()).toBeUndefined();
	});
});

describe("sample", () => {
	it("samples no more than the budget and records the count", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-10-22T02:00:00Z"));
		const items = Array.from({ length: 50 }, (_, i) => ({ pk: "p", sk: String(i) }));
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: items } : {}));
		const out = await sample({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 5, sample_limit: 20 });
		expect(out.keys).toHaveLength(5);
		const puts = sent(PutCommand);
		expect(puts).toHaveLength(1);
		expect(puts[0]!.input).toEqual({
			TableName: "quotas",
			Item: { window: "a#evals#2026-10-21", used: 5, expires_at: Math.floor(Date.now() / 1000) + 3 * 86_400 },
		});
	});

	it("loads the org's rubric from its profile for the judge step", async () => {
		ddb.send.mockImplementation(async (c) =>
			c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : c instanceof GetCommand ? { Item: profile("a", { rubric: "r" }) } : {},
		);
		const out = await sample({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 5, sample_limit: 20 });
		expect(out.rubric).toBe("r");
		expect(sent(GetCommand)[0]!.input).toMatchObject({ TableName: "accounts", Key: { pk: "ORG#a", sk: "PROFILE" } });
	});

	it("returns a null rubric for a profile that uses the default", async () => {
		ddb.send.mockImplementation(async (c) =>
			c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : c instanceof GetCommand ? { Item: profile("a", { rubric: null }) } : {},
		);
		const out = await sample({ tenant_id: "a", name: "A", rubric: "stale", day: "2026-10-21", sample_budget: 5, sample_limit: 20 });
		expect(out.rubric).toBeNull();
	});

	it("falls back to the ref's rubric for a legacy tenant with no profile", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : {}));
		const out = await sample({ tenant_id: "t", name: "Old", rubric: "legacy", day: "2026-10-21", sample_budget: 5, sample_limit: 20 });
		expect(out.rubric).toBe("legacy");
	});

	for (const status of ["deleting", "deleted", "suspended"]) {
		it(`grades nothing for a ${status} org, so the run ends at NothingToGrade`, async () => {
			ddb.send.mockImplementation(async (c) =>
				c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : c instanceof GetCommand ? { Item: profile("a", { status, rubric: "r" }) } : {},
			);
			const ref = { tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 5, sample_limit: 20 };
			expect(await sample(ref)).toEqual({ ...ref, rubric: null, keys: [] });
			expect(sent(QueryCommand)).toHaveLength(0);
			expect(sent(PutCommand)).toHaveLength(0);
		});
	}

	it("records how many it actually took when fewer traces exist", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : {}));
		const out = await sample({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 13, sample_limit: 20 });
		expect(out.keys.length).toBeGreaterThan(0);
		expect(sent(PutCommand)[0]!.input.Item).toMatchObject({ window: "a#evals#2026-10-21", used: out.keys.length });
	});
});

describe("record", () => {
	const graded = [{ key: { pk: "p", sk: "1" }, event_id: "e1", route: "r", scores: { overall: 1, safety: 1, reason: "bad" } }];
	for (const status of ["deleting", "deleted", "suspended"]) {
		it(`writes, publishes and alerts nothing for a ${status} org`, async () => {
			const info = vi.spyOn(console, "info").mockImplementation(() => {});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			ddb.send.mockImplementation(async (c) => (c instanceof GetCommand ? { Item: profile("a", { status }) } : { Items: [] }));
			await record({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 5, sample_limit: 20, results: graded as never });
			expect(sent(GetCommand)[0]!.input).toMatchObject({ TableName: "accounts", Key: { pk: "ORG#a", sk: "PROFILE" } });
			expect(sent(PutCommand)).toHaveLength(0);
			expect(sent(QueryCommand)).toHaveLength(0);
			expect(cwSend).not.toHaveBeenCalled();
			expect(snsSend).not.toHaveBeenCalled();
			expect([...info.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).some((l) => l.includes("not active"))).toBe(true);
			info.mockRestore();
			warn.mockRestore();
		});
	}

	it("records the shortfall on the run", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [] } : {}));
		await record({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 13, sample_limit: 20, results: [] });
		const item = sent(PutCommand)[0]!.input.Item!;
		expect(item).toMatchObject({ tenant_id: "a", sample_budget: 13, sample_shortfall: 7 });
	});
});
