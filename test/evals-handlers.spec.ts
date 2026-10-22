import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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
});
afterEach(() => vi.useRealTimers());

describe("listTenants", () => {
	it("evaluates active orgs with evals on, with their rubric", async () => {
		scans([profile("a", { rubric: "r" }), profile("b", { evals_enabled: false })]);
		const { tenants } = await listTenants({ day: "2026-10-21" });
		expect(tenants).toEqual([{ tenant_id: "a", name: "A", rubric: "r", day: "2026-10-21", sample_budget: 20, sample_limit: 20 }]);
		expect(metric()).toBeUndefined();
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

	it("records how many it actually took when fewer traces exist", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : {}));
		const out = await sample({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 13, sample_limit: 20 });
		expect(out.keys.length).toBeGreaterThan(0);
		expect(sent(PutCommand)[0]!.input.Item).toMatchObject({ window: "a#evals#2026-10-21", used: out.keys.length });
	});
});

describe("record", () => {
	it("records the shortfall on the run", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [] } : {}));
		await record({ tenant_id: "a", name: "A", rubric: null, day: "2026-10-21", sample_budget: 13, sample_limit: 20, results: [] });
		const item = sent(PutCommand)[0]!.input.Item!;
		expect(item).toMatchObject({ tenant_id: "a", sample_budget: 13, sample_shortfall: 7 });
	});
});
