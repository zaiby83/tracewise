import type { SQSEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/tenants", () => ({ ddb }));
process.env.TRACES_TABLE = "traces";

const { handler, toItem } = await import("../services/processor/handler");

const queued = (over: object = {}) => ({
	event_id: crypto.randomUUID(), ts: "2026-10-21T18:00:00.000Z", model: "m", input: "i", output: "o",
	latency_ms: 5, status: "ok", tenant_id: "t1", received_at: "2026-10-21T18:00:01.000Z", ...over,
});
const sqsEvent = (bodies: string[]) =>
	({ Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) }) as unknown as SQSEvent;

describe("processor", () => {
	beforeEach(() => ddb.send.mockReset().mockResolvedValue({ UnprocessedItems: {} }));

	it("builds items keyed by tenant, day and shard, with a TTL", () => {
		const item = toItem({ messageId: "m", body: JSON.stringify(queued()) } as never)!;
		expect(item.pk).toMatch(/^t1#2026-10-21#\d$/);
		expect(item.sk).toMatch(/^2026-10-21T18:00:00.000Z#/);
		expect(item.expires_at).toBe(Math.floor(Date.parse("2026-10-21T18:00:00.000Z") / 1000) + 30 * 86400);
	});

	it("writes in chunks of 25 and reports no failures on success", async () => {
		const res = await handler(sqsEvent(Array.from({ length: 60 }, () => JSON.stringify(queued()))));
		expect(ddb.send).toHaveBeenCalledTimes(3);
		expect(res.batchItemFailures).toEqual([]);
	});

	it("reports only the unparseable message as failed", async () => {
		const res = await handler(sqsEvent([JSON.stringify(queued()), "{broken", JSON.stringify(queued())]));
		expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
	});

	it("retries unprocessed items, then returns the stragglers to the queue", async () => {
		const stuck = queued();
		const stuckItem = toItem({ messageId: "x", body: JSON.stringify(stuck) } as never)!;
		ddb.send.mockResolvedValue({ UnprocessedItems: { traces: [{ PutRequest: { Item: stuckItem } }] } });
		const res = await handler(sqsEvent([JSON.stringify(queued()), JSON.stringify(stuck)]));
		expect(ddb.send.mock.calls.length).toBeGreaterThan(1);
		expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
	});
});
