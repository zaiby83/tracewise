import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { BatchWriteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { k } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { log } from "../shared/http";
import { MAX_RETENTION_DAYS, partitionsForDay } from "../shared/keys";

export type Phase = "dynamo" | "evals" | "s3" | "sweep" | "accounts";

export interface DeletionMessage {
	org_id: string;
	phase: Phase;
	// anchor: the UTC date (YYYY-MM-DD) the first message ran on, carried through every phase
	// so day offsets mean the same thing however late a message is delivered.
	// dynamo and sweep: day (an offset back from the anchor, -1 being the day after) and shard
	// to resume at, plus the query's lastKey. evals: lastKey. sweep: step "evals" once its trace
	// pass is done and the eval-run pass is resuming from lastKey. s3 and sweep: the ListObjectsV2
	// continuation token (in sweep, its presence means the trace and eval-run passes are done).
	cursor?: { anchor?: string; day?: number; shard?: number; lastKey?: Record<string, unknown>; token?: string; step?: "evals" };
}

const PHASES: readonly string[] = ["dynamo", "evals", "s3", "sweep", "accounts"];
const DDB_BATCH = 25; // BatchWriteItem's maximum
const BATCHES_PER_RUN = 20;
const S3_BATCH = 1000; // DeleteObjects' maximum
const S3_CALLS_PER_RUN = 3;
const MAX_ATTEMPTS = 4;
const SWEEP_DELAY_SECONDS = 900;
// Day offsets back from the anchor. Traces expire at most MAX_RETENTION_DAYS (the longest plan)
// after their event and two more days cover TTL lag. Partitions use the client's own date (ts.slice(0, 10)), so an event
// stamped with a +14:00 offset already lands on tomorrow (-1), which is checked last.
const TRACE_DAYS = [...Array.from({ length: MAX_RETENTION_DAYS + 3 }, (_, i) => i), -1];
// The sweep re-checks the days around the anchor for writes that landed after the first pass.
const SWEEP_DAYS = [-1, 0, 1];

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
	// The console only queues a deletion after marking the org `deleting`, but it can roll
	// that back after SQS accepted the message, and dead-letter redrives replay old ones.
	// Anything other than `deleting` ends the chain without touching data.
	if (!(await isDeleting(msg.org_id))) {
		log("warn", "deletion skipped: org not deleting", { org_id: msg.org_id, phase: msg.phase });
		return null;
	}
	const anchor = msg.cursor?.anchor ?? new Date(now).toISOString().slice(0, 10);
	switch (msg.phase) {
		case "dynamo":
			return deleteTraces(msg, anchor, TRACE_DAYS, { org_id: msg.org_id, phase: "evals", cursor: { anchor } });
		case "evals":
			return deleteEvalRuns(msg.org_id, msg.cursor?.lastKey, (lastKey) => ({ org_id: msg.org_id, phase: "evals", cursor: { anchor, lastKey } }), {
				org_id: msg.org_id,
				phase: "s3",
				cursor: { anchor },
			});
		case "s3":
			return deleteLakeObjects(msg, { org_id: msg.org_id, phase: "sweep", cursor: { anchor } });
		case "sweep": {
			// Records the processor or Firehose was still holding when the earlier passes ran.
			if (msg.cursor?.token === undefined) {
				const inEvals = msg.cursor?.step === "evals";
				if (!inEvals) {
					const more = await deleteTraces(msg, anchor, SWEEP_DAYS, null);
					if (more) return more;
				}
				// The record step checks the org is active before writing, but a run that passed that
				// check just before deletion started can land after the evals phase. Its write
				// follows the check within seconds, well inside the sweep's 15-minute delay.
				const more = await deleteEvalRuns(
					msg.org_id,
					inEvals ? msg.cursor?.lastKey : undefined,
					(lastKey) => ({ org_id: msg.org_id, phase: "sweep", cursor: { anchor, step: "evals", lastKey } }),
					null,
				);
				if (more) return more;
			}
			return deleteLakeObjects(msg, { org_id: msg.org_id, phase: "accounts" });
		}
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
					if (msg.phase === "accounts") log("info", "org deleted", { org_id: msg.org_id });
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

async function isDeleting(orgId: string): Promise<boolean> {
	const { Item } = await ddb.send(
		new GetCommand({ TableName: process.env.ACCOUNTS_TABLE, Key: { pk: k.org(orgId), sk: "PROFILE" }, ConsistentRead: true }),
	);
	return Item?.status === "deleting";
}

// Deletes the org's trace partitions for the given day offsets, every shard. `anchor` pins
// offset 0 to the date the first message ran, so a cursor resumed after midnight UTC doesn't
// shift the window. Returns the cursor message when the budget runs out, otherwise `done`.
async function deleteTraces(msg: DeletionMessage, anchor: string, days: number[], done: DeletionMessage | null): Promise<DeletionMessage | null> {
	const table = process.env.TRACES_TABLE!;
	let dayIndex = Math.max(0, days.indexOf(msg.cursor?.day ?? days[0]!));
	let shard = msg.cursor?.shard ?? 0;
	let lastKey = msg.cursor?.lastKey;
	const budget = { batches: BATCHES_PER_RUN };

	while (dayIndex < days.length) {
		const day = days[dayIndex]!;
		const date = new Date(Date.parse(anchor) - day * 86_400_000).toISOString().slice(0, 10);
		const partitions = partitionsForDay(msg.org_id, date);
		do {
			if (budget.batches <= 0) return { org_id: msg.org_id, phase: msg.phase, cursor: { anchor, day, shard, lastKey } };
			const pk = partitions[shard]!;
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
		if (++shard === partitions.length) {
			shard = 0;
			dayIndex++;
		}
	}
	return done;
}

// evals phase, and again in the sweep: the org's runs share one partition (tenant_id), keyed
// by run_at. Returns resume(lastKey) when the budget runs out, otherwise `done`.
async function deleteEvalRuns(
	orgId: string,
	startKey: Record<string, unknown> | undefined,
	resume: (lastKey: Record<string, unknown> | undefined) => DeletionMessage,
	done: DeletionMessage | null,
): Promise<DeletionMessage | null> {
	const table = process.env.EVALS_TABLE!;
	let lastKey = startKey;
	const budget = { batches: BATCHES_PER_RUN };
	do {
		if (budget.batches <= 0) return resume(lastKey);
		const page = await ddb.send(
			new QueryCommand({
				TableName: table,
				KeyConditionExpression: "tenant_id = :t",
				ProjectionExpression: "tenant_id, run_at",
				ExpressionAttributeValues: { ":t": orgId },
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
	return done;
}

// s3 and sweep phases: the same pass over traces/tenant_id=<org>/. The trailing slash
// keeps "o1" from matching "o10". The lake isn't versioned, so DeleteObjects is final.
async function deleteLakeObjects(msg: DeletionMessage, done: DeletionMessage): Promise<DeletionMessage> {
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
		if (!page.IsTruncated) return done;
		if (!page.NextContinuationToken) throw new Error("truncated listing without a continuation token");
		token = page.NextContinuationToken;
	}
	return { org_id: msg.org_id, phase: msg.phase, cursor: { anchor: msg.cursor?.anchor, token } };
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
				// Only a deleting org is tombstoned, and a missing PROFILE isn't recreated as a stub.
				ConditionExpression: "attribute_exists(pk) AND #s = :deleting",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":deleted": "deleted", ":deleting": "deleting", ":now": new Date(now).toISOString() },
			}),
		);
	} catch (err) {
		if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
		log("warn", "profile not deleting, no tombstone written", { org_id: orgId });
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
