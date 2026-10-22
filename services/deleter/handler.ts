import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { BatchWriteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { k } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { log } from "../shared/http";
import { HOT_RETENTION_DAYS, partitionsForDay } from "../shared/keys";

export type Phase = "dynamo" | "evals" | "s3" | "sweep" | "accounts";

export interface DeletionMessage {
	org_id: string;
	phase: Phase;
	// dynamo: day (offset from `token`'s date) and shard to resume at, plus the query's lastKey.
	// evals: lastKey. s3 and sweep: the ListObjectsV2 continuation token.
	cursor?: { day?: number; shard?: number; lastKey?: Record<string, unknown>; token?: string };
}

const PHASES: readonly string[] = ["dynamo", "evals", "s3", "sweep", "accounts"];
const DDB_BATCH = 25; // BatchWriteItem's maximum
const BATCHES_PER_RUN = 20;
const S3_BATCH = 1000; // DeleteObjects' maximum
const S3_CALLS_PER_RUN = 3;
const MAX_ATTEMPTS = 4;
const SWEEP_DELAY_SECONDS = 900;
// Traces expire 30 days after their event; two more days cover TTL lag.
const LAST_DAY_OFFSET = HOT_RETENTION_DAYS + 2;

const s3 = new S3Client({});
const sqs = new SQSClient({});

interface Delete {
	table: string;
	key: Record<string, unknown>;
}

// Deletes an org's data in bounded steps. Each message does one phase's chunk and
// returns the next message: the same phase with a cursor, the following phase, or null
// when the org is gone. Every step is idempotent, so a message that fails (or is
// delivered twice) simply repeats work that is already done. Everything is addressed
// through org_id: the trace partitions, eval runs and S3 prefix are derived from it, and
// the accounts phase only touches the ORG#<id> partition and what its items point at.
export async function runPhase(msg: DeletionMessage, now = Date.now()): Promise<DeletionMessage | null> {
	assertOrgId(msg.org_id);
	switch (msg.phase) {
		case "dynamo":
			return deleteTraces(msg, now);
		case "evals":
			return deleteEvalRuns(msg);
		case "s3":
			return deleteLakeObjects(msg, "sweep");
		case "sweep":
			return deleteLakeObjects(msg, "accounts");
		case "accounts":
			return deleteAccounts(msg.org_id, now);
		default:
			throw new Error(`unknown phase: ${String((msg as { phase: unknown }).phase)}`);
	}
}

// Org ids are generated, but a malformed one must never widen a key prefix or an S3 prefix.
function assertOrgId(orgId: unknown): asserts orgId is string {
	if (typeof orgId !== "string" || !/^[A-Za-z0-9_-]+$/.test(orgId)) throw new Error("invalid org_id");
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
	const failures: string[] = [];
	await Promise.all(
		event.Records.map(async (record) => {
			try {
				const msg = parse(record.body);
				const next = await runPhase(msg);
				if (!next) {
					log("info", "org deleted", { org_id: msg.org_id });
					return;
				}
				await sqs.send(
					new SendMessageCommand({
						QueueUrl: process.env.DELETION_QUEUE_URL,
						MessageBody: JSON.stringify(next),
						// Firehose may still be flushing buffered records for the org; the sweep runs after that.
						DelaySeconds: msg.phase === "s3" && next.phase === "sweep" ? SWEEP_DELAY_SECONDS : undefined,
					}),
				);
			} catch (err) {
				log("error", "deletion step failed", { messageId: record.messageId, error: String(err) });
				failures.push(record.messageId);
			}
		}),
	);
	return { batchItemFailures: failures.map((itemIdentifier) => ({ itemIdentifier })) };
}

function parse(body: string): DeletionMessage {
	const msg = JSON.parse(body) as DeletionMessage;
	if (!msg || typeof msg !== "object" || !PHASES.includes(msg.phase)) throw new Error("invalid deletion message");
	assertOrgId(msg.org_id);
	return msg;
}

// dynamo phase: days 0..HOT_RETENTION_DAYS + 2, every shard. `token` pins day 0 to the
// date the first message ran, so a cursor resumed after midnight UTC doesn't shift the window.
async function deleteTraces(msg: DeletionMessage, now: number): Promise<DeletionMessage> {
	const table = process.env.TRACES_TABLE!;
	const base = msg.cursor?.token ?? new Date(now).toISOString().slice(0, 10);
	let day = msg.cursor?.day ?? 0;
	let shard = msg.cursor?.shard ?? 0;
	let lastKey = msg.cursor?.lastKey;
	const budget = { batches: BATCHES_PER_RUN };

	while (day <= LAST_DAY_OFFSET) {
		const date = new Date(Date.parse(base) - day * 86_400_000).toISOString().slice(0, 10);
		const pk = partitionsForDay(msg.org_id, date)[shard]!;
		do {
			if (budget.batches <= 0) return { org_id: msg.org_id, phase: "dynamo", cursor: { day, shard, lastKey, token: base } };
			const page = await ddb.send(
				new QueryCommand({
					TableName: table,
					KeyConditionExpression: "#pk = :pk",
					ProjectionExpression: "#pk, #sk",
					ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
					ExpressionAttributeValues: { ":pk": pk },
					ExclusiveStartKey: lastKey,
					// Never read more than the rest of the budget can delete.
					Limit: budget.batches * DDB_BATCH,
					ConsistentRead: true,
				}),
			);
			await batchDelete(
				(page.Items ?? []).map((i) => ({ table, key: { pk: i.pk, sk: i.sk } })),
				budget,
			);
			lastKey = page.LastEvaluatedKey;
		} while (lastKey);
		if (++shard === partitionsForDay(msg.org_id, date).length) {
			shard = 0;
			day++;
		}
	}
	return { org_id: msg.org_id, phase: "evals" };
}

// evals phase: the org's runs share one partition (tenant_id), keyed by run_at.
async function deleteEvalRuns(msg: DeletionMessage): Promise<DeletionMessage> {
	const table = process.env.EVALS_TABLE!;
	let lastKey = msg.cursor?.lastKey;
	const budget = { batches: BATCHES_PER_RUN };
	do {
		if (budget.batches <= 0) return { org_id: msg.org_id, phase: "evals", cursor: { lastKey } };
		const page = await ddb.send(
			new QueryCommand({
				TableName: table,
				KeyConditionExpression: "tenant_id = :t",
				ProjectionExpression: "tenant_id, run_at",
				ExpressionAttributeValues: { ":t": msg.org_id },
				ExclusiveStartKey: lastKey,
				Limit: budget.batches * DDB_BATCH,
				ConsistentRead: true,
			}),
		);
		await batchDelete(
			(page.Items ?? []).map((i) => ({ table, key: { tenant_id: i.tenant_id, run_at: i.run_at } })),
			budget,
		);
		lastKey = page.LastEvaluatedKey;
	} while (lastKey);
	return { org_id: msg.org_id, phase: "s3" };
}

// s3 and sweep phases: the same pass over traces/tenant_id=<org>/. The trailing slash
// keeps "o1" from matching "o10". The lake isn't versioned, so DeleteObjects is final.
async function deleteLakeObjects(msg: DeletionMessage, after: Phase): Promise<DeletionMessage> {
	const Bucket = process.env.LAKE_BUCKET!;
	const Prefix = `traces/tenant_id=${msg.org_id}/`;
	let token = msg.cursor?.token;
	for (let call = 0; call < S3_CALLS_PER_RUN; call++) {
		const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token, MaxKeys: S3_BATCH }));
		const keys = (page.Contents ?? []).map((o) => o.Key).filter((key): key is string => !!key && key.startsWith(Prefix));
		if (keys.length) {
			const res = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
			if (res.Errors?.length) throw new Error(`DeleteObjects failed for ${res.Errors.length} keys, first: ${res.Errors[0]?.Key} ${res.Errors[0]?.Code}`);
		}
		if (!page.IsTruncated) return { org_id: msg.org_id, phase: after };
		if (!page.NextContinuationToken) throw new Error("truncated listing without a continuation token");
		token = page.NextContinuationToken;
	}
	return { org_id: msg.org_id, phase: msg.phase, cursor: { token } };
}

// accounts phase: removes everything under ORG#<id> except PROFILE, then the rows that
// point at it from elsewhere, then tombstones PROFILE. An org's partition is small
// (member, key and invite caps), so one invocation handles it without a cursor.
// Dependents go first and the org's own items last: the KEY and INVITE items are the only
// record of which key-index and lookup rows to remove, so a retry after a partial failure
// must still find them.
async function deleteAccounts(orgId: string, now: number): Promise<null> {
	const accounts = process.env.ACCOUNTS_TABLE!;
	const keyIndex = process.env.TENANTS_TABLE!;
	const items: Record<string, unknown>[] = [];
	let lastKey: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(
			new QueryCommand({
				TableName: accounts,
				KeyConditionExpression: "pk = :pk",
				ExpressionAttributeValues: { ":pk": k.org(orgId) },
				ExclusiveStartKey: lastKey,
				ConsistentRead: true,
			}),
		);
		items.push(...(page.Items ?? []));
		lastKey = page.LastEvaluatedKey;
	} while (lastKey);

	const own = items.filter((i) => i.sk !== "PROFILE");
	const dependents: Delete[] = [];
	for (const item of own) {
		const sk = String(item.sk);
		if (sk.startsWith("MEMBER#")) dependents.push({ table: accounts, key: { pk: k.user(sk.slice("MEMBER#".length)), sk: k.org(orgId) } });
		else if (sk.startsWith("KEY#") && typeof item.key_hash === "string") dependents.push({ table: keyIndex, key: { key_hash: item.key_hash } });
		else if (sk.startsWith("INVITE#") && typeof item.token_hash === "string") dependents.push({ table: accounts, key: { pk: k.inviteToken(item.token_hash), sk: "INVITE" } });
	}
	await batchDelete(dependents);
	await batchDelete(own.map((i) => ({ table: accounts, key: { pk: i.pk, sk: i.sk } })));

	try {
		await ddb.send(
			new UpdateCommand({
				TableName: accounts,
				Key: { pk: k.org(orgId), sk: "PROFILE" },
				UpdateExpression: "SET #s = :deleted, deleted_at = :now REMOVE rubric",
				// Without it, updating a missing PROFILE would create a stub item.
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":deleted": "deleted", ":now": new Date(now).toISOString() },
			}),
		);
	} catch (err) {
		if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
		log("warn", "no profile to tombstone", { org_id: orgId });
	}
	return null;
}

// Deletes in BatchWriteItem-sized chunks, spending one unit of `budget` per chunk, with
// the same retry of UnprocessedItems as the processor. Anything that still isn't deleted
// throws, so SQS redelivers the message. Retries aren't counted against the budget.
async function batchDelete(deletes: Delete[], budget?: { batches: number }): Promise<void> {
	for (let i = 0; i < deletes.length; i += DDB_BATCH) {
		if (budget) budget.batches--;
		const request: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> = {};
		for (const { table, key } of deletes.slice(i, i + DDB_BATCH)) (request[table] ??= []).push({ DeleteRequest: { Key: key } });

		let pending: Record<string, unknown> = request;
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_ATTEMPTS && Object.keys(pending).length; attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
			try {
				const res = await ddb.send(new BatchWriteCommand({ RequestItems: pending as never }));
				pending = nonEmpty(res.UnprocessedItems);
				lastError = undefined;
			} catch (err) {
				lastError = err;
				log("warn", "batch delete failed", { attempt, error: String(err) });
			}
		}
		if (Object.keys(pending).length) {
			if (lastError) throw lastError;
			throw new Error(`BatchWrite left unprocessed deletes after ${MAX_ATTEMPTS} attempts`);
		}
	}
}

const nonEmpty = (items: Record<string, unknown[]> | undefined) => Object.fromEntries(Object.entries(items ?? {}).filter(([, v]) => v.length));
