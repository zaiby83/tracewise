import { FirehoseClient } from "@aws-sdk/client-firehose";
import type { SQSEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/tenants", () => ({ ddb }));
process.env.TRACES_TABLE = "traces";
process.env.DELIVERY_STREAM = "stream";

const { handler, toItem } = await import("../services/processor/handler");

const queued = (over: object = {}) => ({
	event_id: crypto.randomUUID(), ts: "2026-10-21T18:00:00.000Z", model: "m", input: "i", output: "o",
	latency_ms: 5, status: "ok", tenant_id: "t1", received_at: "2026-10-21T18:00:01.000Z", ...over,
});
const sqsEvent = (bodies: string[]) =>
	({ Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) }) as unknown as SQSEvent;

describe("processor", () => {
	let firehose: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		ddb.send.mockReset().mockResolvedValue({ UnprocessedItems: {} });
		firehose = vi.spyOn(FirehoseClient.prototype, "send").mockResolvedValue({ FailedPutCount: 0 } as never);
	});

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

	it("streams every event to Firehose as newline-delimited JSON without hot-store keys", async () => {
		await handler(sqsEvent(Array.from({ length: 3 }, () => JSON.stringify(queued()))));
		const input = (firehose.mock.calls[0]![0] as { input: { Records: { Data: Uint8Array }[] } }).input;
		expect(input.Records).toHaveLength(3);
		const line = new TextDecoder().decode(input.Records[0]!.Data);
		expect(line.endsWith("\n")).toBe(true);
		const record = JSON.parse(line);
		expect(record).toMatchObject({ tenant_id: "t1", processed_at: expect.any(String) });
		expect(record).not.toHaveProperty("pk");
		expect(record).not.toHaveProperty("expires_at");
	});

	it("retries only the records Firehose rejected, then fails just those messages", async () => {
		// First call: record 1 of 2 fails. Every retry of that one record fails again.
		firehose
			.mockResolvedValueOnce({ FailedPutCount: 1, RequestResponses: [{}, { ErrorCode: "ServiceUnavailable" }] } as never)
			.mockResolvedValue({ FailedPutCount: 1, RequestResponses: [{ ErrorCode: "ServiceUnavailable" }] } as never);
		const res = await handler(sqsEvent([JSON.stringify(queued()), JSON.stringify(queued())]));
		expect(firehose.mock.calls.length).toBeGreaterThan(1);
		const retried = (firehose.mock.calls[1]![0] as { input: { Records: unknown[] } }).input.Records;
		expect(retried).toHaveLength(1);
		expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
	});
});
