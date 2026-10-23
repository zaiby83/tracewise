import { SendMessageBatchCommand, SQSClient, type SendMessageBatchRequestEntry } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { touchKey } from "../shared/accounts";
import { json, log } from "../shared/http";
import { bearerToken } from "../shared/keys";
import { IngestRequest, validateEvents, type QueuedEvent } from "../shared/schema";
import { canWrite, consumeQuota, releaseQuota, secondsUntil, tenantForKey } from "../shared/tenants";

const sqs = new SQSClient({});
const SQS_BATCH = 10; // SendMessageBatch's maximum

// Seconds until the period ends. A period that has already ended (late renewal webhook, or a
// cached tenant) would give 0, which invites a tight retry loop, so wait a minute instead.
const retryAfter = (periodEnd: string): number => secondsUntil(periodEnd) || 60;

// POST /v1/traces. This function only authenticates, validates and enqueues: the
// request path does no storage writes, so it stays fast under bursts and the queue
// absorbs whatever downstream can't take yet. 202 means every accepted event is
// durably in SQS.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	const key = bearerToken(event.headers.authorization);
	if (!key) return json(401, { error: "missing or malformed API key" });
	const tenant = await tenantForKey(key);
	if (!tenant) return json(401, { error: "invalid API key" });
	if (tenant.key_id) touchKey(tenant.org_id, tenant.key_id);
	if (!canWrite(tenant)) return json(403, { error: "this key is read-only" });

	let body: unknown;
	try {
		body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : (event.body ?? ""));
	} catch {
		return json(400, { error: "body must be JSON" });
	}
	const request = IngestRequest.safeParse(body);
	if (!request.success) return json(400, { error: "expected { events: [...] } with 1 to 100 events" });

	const { valid, rejected } = validateEvents(request.data.events);
	if (valid.length === 0) return json(400, { error: "no valid events", rejected });

	const quota = await consumeQuota(tenant, valid.length);
	if (quota !== "ok") {
		log("warn", "quota exceeded", { tenant_id: tenant.tenant_id, events: valid.length, limit: quota });
		if (quota === "month" || quota === "spend_cap") {
			const error = quota === "month" ? "monthly event allowance used" : "spend cap reached";
			return json(429, { error }, { "retry-after": String(retryAfter(tenant.period_end)), "x-tracewise-limit": quota });
		}
		return json(429, { error: "events-per-minute quota exceeded" }, { "retry-after": "60", "x-tracewise-limit": "minute" });
	}

	const received_at = new Date().toISOString();
	const entries: SendMessageBatchRequestEntry[] = valid.map((e, i) => ({
		Id: String(i),
		MessageBody: JSON.stringify({ ...e, tenant_id: tenant.tenant_id, received_at, retention_days: tenant.retention_days } satisfies QueuedEvent),
	}));

	// A thrown SQS error (throttling, timeout, permissions) is the same outcome as refused
	// entries: nothing is known to be queued, so count the whole batch as failed.
	let failed: number;
	try {
		failed = await enqueue(entries);
	} catch (err) {
		log("error", "enqueue threw", { tenant_id: tenant.tenant_id, error: err instanceof Error ? err.message : String(err) });
		failed = entries.length;
	}
	if (failed > 0) {
		// The client retries the whole batch; event ids make the retry idempotent.
		log("error", "enqueue failed", { tenant_id: tenant.tenant_id, failed, total: entries.length });
		// The retry will be counted again, so give these back. Only the failed entries never
		// reached the queue, but the client resends the whole batch, so all are released.
		await releaseQuota(tenant, valid.length);
		return json(503, { error: "temporarily unable to accept events, retry" }, { "retry-after": "2" });
	}

	log("info", "accepted", { tenant_id: tenant.tenant_id, accepted: valid.length, rejected: rejected.length });
	return json(202, { accepted: valid.length, rejected });
}

// Sends in chunks of 10, in parallel, retrying any partially failed entries once.
async function enqueue(entries: SendMessageBatchRequestEntry[]): Promise<number> {
	const chunks: SendMessageBatchRequestEntry[][] = [];
	for (let i = 0; i < entries.length; i += SQS_BATCH) chunks.push(entries.slice(i, i + SQS_BATCH));

	const send = async (chunk: SendMessageBatchRequestEntry[]) => {
		const res = await sqs.send(new SendMessageBatchCommand({ QueueUrl: process.env.QUEUE_URL, Entries: chunk }));
		const failedIds = new Set((res.Failed ?? []).map((f) => f.Id));
		return chunk.filter((e) => failedIds.has(e.Id));
	};

	const firstFailures = (await Promise.all(chunks.map(send))).flat();
	if (firstFailures.length === 0) return 0;
	return (await send(firstFailures)).length;
}
