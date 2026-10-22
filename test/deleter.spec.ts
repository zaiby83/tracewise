import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { BatchWriteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
Object.assign(process.env, {
	TRACES_TABLE: "traces",
	EVALS_TABLE: "evals",
	ACCOUNTS_TABLE: "accounts",
	TENANTS_TABLE: "tenants",
	LAKE_BUCKET: "lake",
	DELETION_QUEUE_URL: "https://sqs.test/deletion",
});

const { handler, runPhase } = await import("../services/deleter/handler");
const { HOT_RETENTION_DAYS } = await import("../services/shared/keys");

const s3Send = vi.spyOn(S3Client.prototype, "send");
const sqsSend = vi.spyOn(SQSClient.prototype, "send");

const sent = <T>(ctor: new (...a: never[]) => T) => ddb.send.mock.calls.map((c) => c[0]).filter((c) => c instanceof ctor) as T[];
const s3Sent = <T>(ctor: new (...a: never[]) => T) => s3Send.mock.calls.map((c) => c[0]).filter((c) => c instanceof ctor) as T[];
const now = Date.parse("2026-10-22T12:00:00Z");

beforeEach(() => {
	ddb.send.mockReset();
	s3Send.mockReset();
	sqsSend.mockReset().mockResolvedValue({} as never);
});
afterEach(() => vi.useRealTimers());

describe("deleter: dynamo phase", () => {
	it("deletes trace partitions shard by shard and returns a cursor when the budget runs out", async () => {
		ddb.send.mockImplementation(async (c) =>
			c instanceof QueryCommand ? { Items: Array.from({ length: 100 }, (_, i) => ({ pk: "p", sk: String(i) })), LastEvaluatedKey: { pk: "p" } } : { UnprocessedItems: {} },
		);
		const next = await runPhase({ org_id: "o1", phase: "dynamo" }, now);
		expect(next).toMatchObject({ org_id: "o1", phase: "dynamo", cursor: { day: 0, shard: 0, lastKey: { pk: "p" } } });
		expect(sent(BatchWriteCommand).length).toBeLessThanOrEqual(20);
		expect(sent(BatchWriteCommand).length).toBe(20);
		const first = sent(BatchWriteCommand)[0]!.input.RequestItems!.traces!;
		expect(first).toHaveLength(25);
		expect(first[0]).toEqual({ DeleteRequest: { Key: { pk: "p", sk: "0" } } });
	});

	it("covers HOT_RETENTION_DAYS + 2 days of partitions before moving on", async () => {
		ddb.send.mockResolvedValue({ Items: [] });
		const next = await runPhase({ org_id: "o1", phase: "dynamo" }, now);
		expect(next).toEqual({ org_id: "o1", phase: "evals" });
		const pks = sent(QueryCommand).map((q) => q.input.ExpressionAttributeValues![":pk"]);
		const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
		expect(pks).toHaveLength((HOT_RETENTION_DAYS + 3) * 10);
		expect(pks).toContain(`o1#${day(0)}#0`);
		expect(pks).toContain(`o1#${day(HOT_RETENTION_DAYS + 2)}#9`);
		expect(pks).not.toContain(`o1#${day(HOT_RETENTION_DAYS + 3)}#0`);
		expect(pks.every((p) => String(p).startsWith("o1#"))).toBe(true);
	});

	it("resumes from its cursor and keeps the day anchored across midnight", async () => {
		ddb.send.mockResolvedValue({ Items: [] });
		const later = Date.parse("2026-10-23T00:30:00Z");
		const first = await runPhase({ org_id: "o1", phase: "dynamo" }, now);
		expect(first).toEqual({ org_id: "o1", phase: "evals" });
		ddb.send.mockClear();
		// A cursor taken on the 22nd and resumed after midnight still counts days from the 22nd.
		const next = await runPhase({ org_id: "o1", phase: "dynamo", cursor: { day: 31, shard: 8, token: "2026-10-22" } }, later);
		expect(next).toEqual({ org_id: "o1", phase: "evals" });
		const q = sent(QueryCommand).map((c) => c.input.ExpressionAttributeValues![":pk"]);
		expect(q).toEqual(["o1#2026-09-21#8", "o1#2026-09-21#9", "o1#2026-09-20#0", "o1#2026-09-20#1", "o1#2026-09-20#2", "o1#2026-09-20#3", "o1#2026-09-20#4", "o1#2026-09-20#5", "o1#2026-09-20#6", "o1#2026-09-20#7", "o1#2026-09-20#8", "o1#2026-09-20#9"]);
	});

	it("passes the cursor's lastKey on as ExclusiveStartKey and only asks for keys", async () => {
		ddb.send.mockResolvedValue({ Items: [] });
		await runPhase({ org_id: "o1", phase: "dynamo", cursor: { day: 32, shard: 9, lastKey: { pk: "o1#d#9", sk: "x" }, token: "2026-10-22" } }, now);
		const q = sent(QueryCommand)[0]!.input;
		expect(q).toMatchObject({ TableName: "traces", ExclusiveStartKey: { pk: "o1#d#9", sk: "x" }, ProjectionExpression: "#pk, #sk" });
	});

	it("retries unprocessed deletes with backoff and throws if they never clear", async () => {
		vi.useFakeTimers();
		const item = { DeleteRequest: { Key: { pk: "p", sk: "1" } } };
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ pk: "p", sk: "1" }] } : { UnprocessedItems: { traces: [item] } }));
		const run = runPhase({ org_id: "o1", phase: "dynamo" }, now);
		const settled = expect(run).rejects.toThrow(/unprocessed/i);
		await vi.runAllTimersAsync();
		await settled;
		const writes = sent(BatchWriteCommand);
		expect(writes.length).toBeGreaterThan(1);
		expect(writes[1]!.input.RequestItems).toEqual({ traces: [item] });
	});

	it("recovers when a retry clears the unprocessed items", async () => {
		vi.useFakeTimers();
		ddb.send.mockImplementation(async (c) => {
			if (c instanceof QueryCommand) return { Items: sent(QueryCommand).length === 1 ? [{ pk: "p", sk: "1" }] : [] };
			return sent(BatchWriteCommand).length === 1 ? { UnprocessedItems: { traces: [{ DeleteRequest: { Key: { pk: "p", sk: "1" } } }] } } : { UnprocessedItems: {} };
		});
		const run = runPhase({ org_id: "o1", phase: "dynamo" }, now);
		await vi.runAllTimersAsync();
		await expect(run).resolves.toEqual({ org_id: "o1", phase: "evals" });
	});
});

describe("deleter: evals phase", () => {
	it("deletes only the org's runs, then moves to s3", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ tenant_id: "o1", run_at: "r1" }, { tenant_id: "o1", run_at: "r2" }] } : { UnprocessedItems: {} }));
		const next = await runPhase({ org_id: "o1", phase: "evals" }, now);
		expect(next).toEqual({ org_id: "o1", phase: "s3" });
		expect(sent(QueryCommand)[0]!.input).toMatchObject({ TableName: "evals", ExpressionAttributeValues: { ":t": "o1" } });
		expect(sent(BatchWriteCommand)[0]!.input.RequestItems).toEqual({
			evals: [{ DeleteRequest: { Key: { tenant_id: "o1", run_at: "r1" } } }, { DeleteRequest: { Key: { tenant_id: "o1", run_at: "r2" } } }],
		});
	});
	it("returns a cursor when the budget runs out", async () => {
		ddb.send.mockImplementation(async (c) =>
			c instanceof QueryCommand ? { Items: Array.from({ length: 100 }, (_, i) => ({ tenant_id: "o1", run_at: String(i) })), LastEvaluatedKey: { tenant_id: "o1", run_at: "99" } } : { UnprocessedItems: {} },
		);
		const next = await runPhase({ org_id: "o1", phase: "evals" }, now);
		expect(next).toMatchObject({ phase: "evals", cursor: { lastKey: { tenant_id: "o1", run_at: "99" } } });
		expect(sent(BatchWriteCommand).length).toBe(20);
	});
});

describe("deleter: s3 phases", () => {
	it("deletes only the org's S3 prefix", async () => {
		s3Send.mockImplementation(async (c) => (c instanceof ListObjectsV2Command ? { Contents: [{ Key: "traces/tenant_id=o1/dt=1/a" }, { Key: "traces/tenant_id=o1/dt=1/b" }], IsTruncated: false } : {}) as never);
		const next = await runPhase({ org_id: "o1", phase: "s3" }, now);
		expect(next).toEqual({ org_id: "o1", phase: "sweep" });
		expect(s3Sent(ListObjectsV2Command)[0]!.input).toMatchObject({ Bucket: "lake", Prefix: "traces/tenant_id=o1/" });
		expect(s3Sent(DeleteObjectsCommand)[0]!.input).toMatchObject({
			Bucket: "lake",
			Delete: { Objects: [{ Key: "traces/tenant_id=o1/dt=1/a" }, { Key: "traces/tenant_id=o1/dt=1/b" }] },
		});
	});
	it("never deletes a key outside the org's prefix, even if the listing returns one", async () => {
		s3Send.mockImplementation(async (c) => (c instanceof ListObjectsV2Command ? { Contents: [{ Key: "traces/tenant_id=o10/a" }, { Key: "traces/tenant_id=o1/a" }] } : {}) as never);
		await runPhase({ org_id: "o1", phase: "s3" }, now);
		expect(s3Sent(DeleteObjectsCommand)[0]!.input.Delete!.Objects).toEqual([{ Key: "traces/tenant_id=o1/a" }]);
	});
	it("stops after 3 DeleteObjects calls and continues from the continuation token", async () => {
		s3Send.mockImplementation(async (c) =>
			(c instanceof ListObjectsV2Command ? { Contents: [{ Key: "traces/tenant_id=o1/k" }], IsTruncated: true, NextContinuationToken: `t${s3Sent(ListObjectsV2Command).length}` } : {}) as never,
		);
		const next = await runPhase({ org_id: "o1", phase: "s3", cursor: { token: "t0" } }, now);
		expect(next).toEqual({ org_id: "o1", phase: "s3", cursor: { token: "t3" } });
		expect(s3Sent(DeleteObjectsCommand)).toHaveLength(3);
		expect(s3Sent(ListObjectsV2Command)[0]!.input).toMatchObject({ ContinuationToken: "t0", MaxKeys: 1000 });
	});
	it("throws when DeleteObjects reports per-key errors", async () => {
		s3Send.mockImplementation(async (c) => (c instanceof ListObjectsV2Command ? { Contents: [{ Key: "traces/tenant_id=o1/k" }] } : { Errors: [{ Key: "traces/tenant_id=o1/k", Code: "AccessDenied" }] }) as never);
		await expect(runPhase({ org_id: "o1", phase: "s3" }, now)).rejects.toThrow(/DeleteObjects/);
	});
	it("sweep makes one more pass and then moves to accounts", async () => {
		s3Send.mockResolvedValue({ Contents: [], IsTruncated: false } as never);
		expect(await runPhase({ org_id: "o1", phase: "sweep" }, now)).toEqual({ org_id: "o1", phase: "accounts" });
		expect(s3Sent(DeleteObjectsCommand)).toHaveLength(0);
	});
	it("schedules the sweep 15 minutes after the first S3 pass", async () => {
		s3Send.mockResolvedValue({ Contents: [], IsTruncated: false } as never);
		const res = await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ org_id: "o1", phase: "s3" }) }] } as never);
		expect(res.batchItemFailures).toEqual([]);
		const cmd = sqsSend.mock.calls[0]![0] as SendMessageCommand;
		expect(cmd.input).toMatchObject({ QueueUrl: "https://sqs.test/deletion", DelaySeconds: 900, MessageBody: JSON.stringify({ org_id: "o1", phase: "sweep" }) });
	});
	it("re-enqueues other phases without a delay", async () => {
		ddb.send.mockResolvedValue({ Items: [] });
		await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ org_id: "o1", phase: "dynamo" }) }] } as never);
		const cmd = sqsSend.mock.calls[0]![0] as SendMessageCommand;
		expect(cmd.input.DelaySeconds).toBeUndefined();
		expect(JSON.parse(cmd.input.MessageBody!)).toEqual({ org_id: "o1", phase: "evals" });
	});
});

describe("deleter: accounts phase", () => {
	it("leaves a tombstone after removing members, keys, invites and key-index rows", async () => {
		ddb.send.mockImplementation(async (c) =>
			c instanceof QueryCommand
				? {
						Items: [
							{ pk: "ORG#o1", sk: "PROFILE" },
							{ pk: "ORG#o1", sk: "MEMBER#u1", sub: "u1" },
							{ pk: "ORG#o1", sk: "KEY#k1", key_hash: "h1" },
							{ pk: "ORG#o1", sk: "INVITE#i1", token_hash: "th1" },
						],
					}
				: { UnprocessedItems: {} },
		);
		const next = await runPhase({ org_id: "o1", phase: "accounts" }, now);
		expect(next).toBeNull();
		expect(sent(QueryCommand)[0]!.input).toMatchObject({ TableName: "accounts", ExpressionAttributeValues: { ":pk": "ORG#o1" } });
		const deletes = sent(BatchWriteCommand).flatMap((c) =>
			Object.entries(c.input.RequestItems!).flatMap(([table, reqs]) => reqs.map((r) => ({ table, key: r.DeleteRequest!.Key }))),
		);
		expect(deletes).toHaveLength(6);
		expect(deletes).toEqual(
			expect.arrayContaining([
				{ table: "accounts", key: { pk: "ORG#o1", sk: "MEMBER#u1" } },
				{ table: "accounts", key: { pk: "ORG#o1", sk: "KEY#k1" } },
				{ table: "accounts", key: { pk: "ORG#o1", sk: "INVITE#i1" } },
				{ table: "accounts", key: { pk: "USER#u1", sk: "ORG#o1" } },
				{ table: "accounts", key: { pk: "INVITE#th1", sk: "INVITE" } },
				{ table: "tenants", key: { key_hash: "h1" } },
			]),
		);
		expect(deletes.some((d) => d.key?.sk === "PROFILE")).toBe(false);
		const update = sent(UpdateCommand)[0]!.input;
		expect(update).toMatchObject({ TableName: "accounts", Key: { pk: "ORG#o1", sk: "PROFILE" }, ExpressionAttributeValues: { ":deleted": "deleted", ":now": new Date(now).toISOString() } });
		expect(update.UpdateExpression).toMatch(/^SET .*REMOVE rubric$/);
	});

	it("removes the dependents before the org's own items, so a retry can still find them", async () => {
		const order: string[] = [];
		ddb.send.mockImplementation(async (c) => {
			if (c instanceof QueryCommand) return { Items: [{ pk: "ORG#o1", sk: "KEY#k1", key_hash: "h1" }] };
			if (c instanceof BatchWriteCommand) for (const reqs of Object.values(c.input.RequestItems!)) for (const r of reqs) order.push(JSON.stringify(r.DeleteRequest!.Key));
			return { UnprocessedItems: {} };
		});
		await runPhase({ org_id: "o1", phase: "accounts" }, now);
		expect(order).toEqual([JSON.stringify({ key_hash: "h1" }), JSON.stringify({ pk: "ORG#o1", sk: "KEY#k1" })]);
	});

	it("does not write the tombstone when deleting an item fails", async () => {
		vi.useFakeTimers();
		ddb.send.mockImplementation(async (c) => {
			if (c instanceof QueryCommand) return { Items: [{ pk: "ORG#o1", sk: "MEMBER#u1", sub: "u1" }] };
			if (c instanceof BatchWriteCommand) throw new Error("throttled");
			return {};
		});
		const run = runPhase({ org_id: "o1", phase: "accounts" }, now);
		const settled = expect(run).rejects.toThrow(/throttled|unprocessed/i);
		await vi.runAllTimersAsync();
		await settled;
		expect(sent(UpdateCommand)).toHaveLength(0);
	});

	it("pages through the org's partition", async () => {
		ddb.send.mockImplementation(async (c) => {
			if (c instanceof QueryCommand) return c.input.ExclusiveStartKey ? { Items: [{ pk: "ORG#o1", sk: "MEMBER#u2", sub: "u2" }] } : { Items: [{ pk: "ORG#o1", sk: "MEMBER#u1", sub: "u1" }], LastEvaluatedKey: { pk: "ORG#o1", sk: "MEMBER#u1" } };
			return { UnprocessedItems: {} };
		});
		await runPhase({ org_id: "o1", phase: "accounts" }, now);
		expect(sent(QueryCommand)).toHaveLength(2);
		expect(JSON.stringify(sent(BatchWriteCommand).map((c) => c.input.RequestItems))).toContain("USER#u2");
	});
});

describe("deleter: handler", () => {
	it("reports a failed message so SQS retries it", async () => {
		ddb.send.mockRejectedValue(new Error("boom"));
		s3Send.mockResolvedValue({ Contents: [], IsTruncated: false } as never);
		const res = await handler({
			Records: [
				{ messageId: "bad", body: JSON.stringify({ org_id: "o1", phase: "dynamo" }) },
				{ messageId: "ok", body: JSON.stringify({ org_id: "o2", phase: "sweep" }) },
			],
		} as never);
		expect(res.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
	});
	it("reports a message it cannot enqueue the next step for", async () => {
		ddb.send.mockResolvedValue({ Items: [] });
		sqsSend.mockRejectedValue(new Error("sqs down"));
		const res = await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ org_id: "o1", phase: "dynamo" }) }] } as never);
		expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
	});
	it("fails unparseable and invalid messages without touching any data", async () => {
		const res = await handler({
			Records: [
				{ messageId: "a", body: "not json" },
				{ messageId: "b", body: JSON.stringify({ org_id: "", phase: "dynamo" }) },
				{ messageId: "c", body: JSON.stringify({ org_id: "o1", phase: "everything" }) },
				{ messageId: "d", body: JSON.stringify({ org_id: "o1/../o2", phase: "s3" }) },
			],
		} as never);
		expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["a", "b", "c", "d"]);
		expect(ddb.send).not.toHaveBeenCalled();
		expect(s3Send).not.toHaveBeenCalled();
	});
	it("finishes quietly after the accounts phase", async () => {
		ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: [{ pk: "ORG#o1", sk: "PROFILE" }] } : { UnprocessedItems: {} }));
		const res = await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ org_id: "o1", phase: "accounts" }) }] } as never);
		expect(res.batchItemFailures).toEqual([]);
		expect(sqsSend).not.toHaveBeenCalled();
	});
});
