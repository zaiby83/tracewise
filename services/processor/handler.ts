import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { log } from "../shared/http";
import { HOT_RETENTION_DAYS, expiresAt, partitionKey, sortKey } from "../shared/keys";
import type { QueuedEvent } from "../shared/schema";
import { ddb } from "../shared/tenants";

const DDB_BATCH = 25; // BatchWriteItem's maximum
const FIREHOSE_BATCH = 500; // PutRecordBatch's maximum
const MAX_ATTEMPTS = 4;
const DAY_MS = 86_400_000;
const firehose = new FirehoseClient({});

// Consumes queued events in batches and writes each one twice: to the hot store
// (DynamoDB, when its ts is inside the hot window) and to the analytics stream (Firehose →
// S3 Parquet). Failures are reported per message (ReportBatchItemFailures), so a failed
// write retries only that message.
// DynamoDB writes are idempotent; a retried message may reach Firehose twice, which
// analytics tolerates by counting distinct event ids.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
	const failures = new Set<string>();
	const items: { messageId: string; item: Record<string, unknown> }[] = [];

	for (const record of event.Records) {
		const item = toItem(record);
		if (item) items.push({ messageId: record.messageId, item });
		else failures.add(record.messageId);
	}

	const now = Date.now();
	const hot = items.filter(({ item }) => inHotWindow(String(item.ts), now));
	// Content stays out of the log: just how many, so a misconfigured client clock shows up.
	if (hot.length < items.length) log("warn", "events outside the hot store window, streamed only", { skipped: items.length - hot.length, total: items.length });

	const failed = await Promise.all([
		...chunk(hot, DDB_BATCH).map(writeChunk),
		...(process.env.DELIVERY_STREAM ? chunk(items, FIREHOSE_BATCH).map(streamChunk) : []),
	]);
	for (const id of failed.flat()) failures.add(id);

	if (failures.size) log("warn", "batch had failures", { failed: failures.size, total: event.Records.length });
	return { batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier })) };
}

export function toItem(record: SQSRecord): Record<string, unknown> | null {
	try {
		const e = JSON.parse(record.body) as QueuedEvent;
		return {
			pk: partitionKey(e.tenant_id, e.ts, e.event_id),
			sk: sortKey(e.ts, e.event_id),
			expires_at: expiresAt(e.ts),
			...e,
			// With received_at, this gives the pipeline's own latency (queue + processing).
			processed_at: new Date().toISOString(),
		};
	} catch (err) {
		log("error", "unparseable message", { messageId: record.messageId, error: String(err) });
		return null;
	}
}

// The client sets ts, and the hot store derives the partition (ts.slice(0, 10)) and TTL from
// it. The org deleter only visits partitions from tomorrow back to HOT_RETENTION_DAYS + 2, and
// TTL ignores expiries more than five years past, so a far-future or very old event would
// outlive its org's deletion. Those go to the lake only, which the deleter clears by prefix.
// The day check catches a +14:00 stamp whose instant is in range but whose date is past tomorrow.
export function inHotWindow(ts: string, now = Date.now()): boolean {
	const at = Date.parse(ts);
	if (!(at >= now - (HOT_RETENTION_DAYS + 1) * DAY_MS && at <= now + DAY_MS)) return false;
	return ts.slice(0, 10) <= new Date(now + DAY_MS).toISOString().slice(0, 10);
}

function chunk<T>(list: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

// The analytics record: the event without the hot store's key and TTL attributes.
function analyticsRecord(item: Record<string, unknown>): Uint8Array {
	const { pk, sk, expires_at, ...record } = item;
	return new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

// PutRecordBatch also succeeds partially (FailedPutCount); retry just the failed records.
async function streamChunk(batch: { messageId: string; item: Record<string, unknown> }[]): Promise<string[]> {
	let pending = batch;
	for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
		try {
			const res = await firehose.send(
				new PutRecordBatchCommand({
					DeliveryStreamName: process.env.DELIVERY_STREAM,
					Records: pending.map(({ item }) => ({ Data: analyticsRecord(item) })),
				}),
			);
			if (!res.FailedPutCount) return [];
			pending = pending.filter((_, i) => res.RequestResponses?.[i]?.ErrorCode);
		} catch (err) {
			log("warn", "firehose put failed", { attempt, error: String(err) });
		}
	}
	return pending.map((p) => p.messageId);
}

// BatchWriteItem can succeed partially, returning UnprocessedItems under throttling.
// Those are retried with exponential backoff; whatever still fails goes back to SQS.
async function writeChunk(batch: { messageId: string; item: Record<string, unknown> }[]): Promise<string[]> {
	const table = process.env.TRACES_TABLE!;
	let pending = batch;
	for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
		try {
			const res = await ddb.send(
				new BatchWriteCommand({ RequestItems: { [table]: pending.map(({ item }) => ({ PutRequest: { Item: item } })) } }),
			);
			const unprocessed = new Set((res.UnprocessedItems?.[table] ?? []).map((r) => `${r.PutRequest?.Item?.pk}|${r.PutRequest?.Item?.sk}`));
			pending = pending.filter(({ item }) => unprocessed.has(`${item.pk}|${item.sk}`));
		} catch (err) {
			log("warn", "batch write failed", { attempt, error: String(err) });
		}
	}
	return pending.map((p) => p.messageId);
}
