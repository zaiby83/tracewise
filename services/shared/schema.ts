import { z } from "zod";

export const MAX_EVENT_BYTES = 32 * 1024;
export const MAX_EVENTS_PER_REQUEST = 100;

// One LLM call, as the SDK reports it. `event_id` is generated client-side so that
// retries are idempotent end to end.
export const TraceEvent = z.object({
	event_id: z.uuid(),
	ts: z.iso.datetime({ offset: true }),
	model: z.string().min(1).max(200),
	provider: z.string().max(100).optional(),
	route: z.string().max(200).optional(),
	input: z.string().max(MAX_EVENT_BYTES),
	output: z.string().max(MAX_EVENT_BYTES),
	status: z.enum(["ok", "error"]).default("ok"),
	latency_ms: z.number().int().nonnegative().max(3_600_000),
	tokens_in: z.number().int().nonnegative().optional(),
	tokens_out: z.number().int().nonnegative().optional(),
	cost_usd: z.number().nonnegative().optional(),
	// Prompt Shield or any other guard's decision about this call.
	security: z
		.object({ verdict: z.string().max(50), rules: z.array(z.string().max(100)).max(50) })
		.optional(),
	metadata: z.record(z.string().max(100), z.string().max(1000)).optional(),
});
export type TraceEvent = z.infer<typeof TraceEvent>;

export const IngestRequest = z.object({
	events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_REQUEST),
});

// What travels through the queue: the event plus server-side facts the client can't set.
export interface QueuedEvent extends TraceEvent {
	tenant_id: string;
	received_at: string;
}

export interface Rejected {
	index: number;
	reason: string;
}

// Validates each event on its own, so one bad event doesn't reject the whole batch.
export function validateEvents(raw: unknown[]): { valid: TraceEvent[]; rejected: Rejected[] } {
	const valid: TraceEvent[] = [];
	const rejected: Rejected[] = [];
	raw.forEach((item, index) => {
		if (JSON.stringify(item ?? null).length > MAX_EVENT_BYTES * 2) {
			rejected.push({ index, reason: "event too large" });
			return;
		}
		const parsed = TraceEvent.safeParse(item);
		if (parsed.success) valid.push(parsed.data);
		else rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; ") });
	});
	return { valid, rejected };
}
