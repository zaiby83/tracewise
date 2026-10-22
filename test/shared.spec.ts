import { describe, expect, it } from "vitest";
import { bearerToken, hashApiKey, newApiKey, partitionKey, partitionsForDay, SHARDS, shardOf } from "../services/shared/keys";
import { validateEvents } from "../services/shared/schema";

const event = (over: object = {}) => ({
	event_id: crypto.randomUUID(),
	ts: "2026-10-21T18:00:00.000Z",
	model: "llama-3.3-70b",
	input: "hi",
	output: "hello",
	latency_ms: 420,
	...over,
});

describe("API keys", () => {
	it("generates keys the bearer parser accepts, and hashes them deterministically", () => {
		const key = newApiKey();
		expect(bearerToken(`Bearer ${key}`)).toBe(key);
		expect(hashApiKey(key)).toBe(hashApiKey(key));
		expect(hashApiKey(key)).not.toContain(key);
	});

	it.each([undefined, "", "Bearer", "Bearer sk-not-ours", `Basic tw_${"a".repeat(43)}`])("rejects malformed header %s", (h) => {
		expect(bearerToken(h)).toBeNull();
	});
});

describe("partitioning", () => {
	it("maps the same event to the same partition every time, so retries are idempotent", () => {
		const id = crypto.randomUUID();
		expect(partitionKey("t1", "2026-10-21T18:00:00Z", id)).toBe(partitionKey("t1", "2026-10-21T23:59:59Z", id));
	});

	it("spreads one tenant's events across every shard", () => {
		const shards = new Set(Array.from({ length: 2000 }, () => shardOf(crypto.randomUUID())));
		expect(shards.size).toBe(SHARDS);
	});

	it("lists every shard partition for a day", () => {
		expect(partitionsForDay("t1", "2026-10-21")).toHaveLength(SHARDS);
		expect(partitionsForDay("t1", "2026-10-21")[3]).toBe("t1#2026-10-21#3");
	});
});

describe("event validation", () => {
	it("accepts good events and reports bad ones individually", () => {
		const { valid, rejected } = validateEvents([event(), event({ latency_ms: -1 }), event({ event_id: "nope" }), "junk"]);
		expect(valid).toHaveLength(1);
		expect(rejected.map((r) => r.index)).toEqual([1, 2, 3]);
		expect(rejected[0]!.reason).toContain("latency_ms");
	});

	it("defaults status to ok", () => {
		expect(validateEvents([event()]).valid[0]!.status).toBe("ok");
	});

	it("rejects oversized events", () => {
		expect(validateEvents([event({ output: "x".repeat(40_000) })]).rejected).toHaveLength(1);
	});
});
