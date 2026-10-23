import { FirehoseClient } from "@aws-sdk/client-firehose";
import type { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		// Only Date: the retry tests' backoff uses real timers. Keeps the fixtures' ts in the hot window.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse("2026-10-22T12:00:00Z"));
	});
	afterEach(() => vi.useRealTimers());

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

	describe("hot-store window", () => {
		const putItems = () =>
			ddb.send.mock.calls.flatMap((c) => (c[0].input.RequestItems.traces as { PutRequest: { Item: { event_id: string } } }[]).map((r) => r.PutRequest.Item.event_id));
		const streamed = () =>
			firehose.mock.calls.flatMap((c: unknown[]) =>
				(c[0] as { input: { Records: { Data: Uint8Array }[] } }).input.Records.map((r) => JSON.parse(new TextDecoder().decode(r.Data)).event_id),
			);

		it("streams out-of-window events to Firehose but keeps them out of DynamoDB", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const now = Date.now();
			const future = queued({ ts: new Date(now + 2 * 86_400_000).toISOString(), input: "secret prompt" });
			const old = queued({ ts: new Date(now - 40 * 86_400_000).toISOString() });
			const fresh = queued({ ts: new Date(now - 3_600_000).toISOString() });
			const res = await handler(sqsEvent([future, old, fresh].map((e) => JSON.stringify(e))));
			expect(res.batchItemFailures).toEqual([]);
			expect(putItems()).toEqual([fresh.event_id]);
			expect(streamed().sort()).toEqual([future.event_id, old.event_id, fresh.event_id].sort());
			// One aggregated warning per batch, with a count and no event content.
			const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("hot store"));
			expect(lines).toHaveLength(1);
			expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", skipped: 2, total: 3 });
			expect(lines[0]).not.toContain("secret prompt");
			expect(lines[0]).not.toContain(future.event_id);
			warn.mockRestore();
		});

		it("keeps events at the window's edges, including a +14:00 stamp for tomorrow", async () => {
			const now = Date.now();
			const edges = [
				queued({ ts: new Date(now - 31 * 86_400_000 + 60_000).toISOString() }),
				queued({ ts: new Date(now + 86_400_000 - 60_000).toISOString() }),
				queued({ ts: "2026-10-23T13:00:00.000+14:00" }),
			];
			await handler(sqsEvent(edges.map((e) => JSON.stringify(e))));
			expect(putItems().sort()).toEqual(edges.map((e) => e.event_id).sort());
		});

		it("keeps a +14:00 event out of DynamoDB when its partition day is past tomorrow", async () => {
			// Within a day of now as an instant, but its local date (the partition) is the 24th,
			// which the deleter (tomorrow back to HOT_RETENTION_DAYS + 2) never visits.
			const late = queued({ ts: "2026-10-24T00:30:00.000+14:00" });
			await handler(sqsEvent([JSON.stringify(late)]));
			expect(putItems()).toEqual([]);
			expect(streamed()).toEqual([late.event_id]);
		});

		it("makes no DynamoDB call when a whole batch is out of window", async () => {
			await handler(sqsEvent([JSON.stringify(queued({ ts: "2020-01-01T00:00:00.000Z" }))]));
			expect(ddb.send).not.toHaveBeenCalled();
			expect(firehose).toHaveBeenCalledTimes(1);
		});
	});
});
