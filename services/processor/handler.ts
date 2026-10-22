import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { log } from "../shared/http";
import { expiresAt, partitionKey, sortKey } from "../shared/keys";
import type { QueuedEvent } from "../shared/schema";
import { ddb } from "../shared/tenants";

const DDB_BATCH = 25; // BatchWriteItem's maximum
const FIREHOSE_BATCH = 500; // PutRecordBatch's maximum
const MAX_ATTEMPTS = 4;
const firehose = new FirehoseClient({});

// Consumes queued events in batches and writes each one twice: to the hot store
// (DynamoDB) and to the analytics stream (Firehose → S3 Parquet). Failures are reported
// per message (ReportBatchItemFailures), so a failed write retries only that message.
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

	const failed = await Promise.all([
		...chunk(items, DDB_BATCH).map(writeChunk),
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
