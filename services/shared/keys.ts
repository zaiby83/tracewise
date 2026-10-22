import { createHash, randomBytes } from "node:crypto";

export const SHARDS = 10;
export const HOT_RETENTION_DAYS = 30;

// API keys are 256 random bits, shown to the tenant once. Only the hash is stored, so
// a leaked table doesn't leak working keys.
export function newApiKey(): string {
	return `tw_${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

export function bearerToken(header: string | undefined): string | null {
	const match = header?.match(/^Bearer\s+(tw_[A-Za-z0-9_-]{43})$/);
	return match?.[1] ?? null;
}

// Traces are partitioned by tenant, day and a shard derived from the event id. The
// shard spreads one busy tenant's writes over several partitions; deriving it from the
// event id keeps retries landing on the same item, so writes stay idempotent.
export function shardOf(eventId: string): number {
	return createHash("sha256").update(eventId).digest()[0]! % SHARDS;
}

export function partitionKey(tenantId: string, ts: string, eventId: string): string {
	return `${tenantId}#${ts.slice(0, 10)}#${shardOf(eventId)}`;
}

export function sortKey(ts: string, eventId: string): string {
	return `${ts}#${eventId}`;
}

export function partitionsForDay(tenantId: string, day: string): string[] {
	return Array.from({ length: SHARDS }, (_, shard) => `${tenantId}#${day}#${shard}`);
}

export function expiresAt(ts: string, days = HOT_RETENTION_DAYS): number {
	return Math.floor(new Date(ts).getTime() / 1000) + days * 86_400;
}
