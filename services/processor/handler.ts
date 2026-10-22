import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { log } from "../shared/http";
import { expiresAt, partitionKey, sortKey } from "../shared/keys";
import type { QueuedEvent } from "../shared/schema";
import { ddb } from "../shared/tenants";

const DDB_BATCH = 25; // BatchWriteItem's maximum
const MAX_ATTEMPTS = 4;

// Consumes queued events in batches and writes them to the hot store. Failures are
// reported per message (ReportBatchItemFailures), so a single bad write retries only
// that message rather than the whole batch. Writes are idempotent: the same event
// always maps to the same key.
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
	const failures = new Set<string>();
	const items: { messageId: string; item: Record<string, unknown> }[] = [];

	for (const record of event.Records) {
		const item = toItem(record);
		if (item) items.push({ messageId: record.messageId, item });
		else failures.add(record.messageId);
	}

	const chunks: (typeof items)[] = [];
	for (let i = 0; i < items.length; i += DDB_BATCH) chunks.push(items.slice(i, i + DDB_BATCH));
	await Promise.all(
		chunks.map(async (chunk) => {
			for (const id of await writeChunk(chunk)) failures.add(id);
		}),
	);

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

// BatchWriteItem can succeed partially, returning UnprocessedItems under throttling.
// Those are retried with exponential backoff; whatever still fails goes back to SQS.
async function writeChunk(chunk: { messageId: string; item: Record<string, unknown> }[]): Promise<string[]> {
	const table = process.env.TRACES_TABLE!;
	let pending = chunk;
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
