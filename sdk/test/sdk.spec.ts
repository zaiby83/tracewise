import { afterEach, describe, expect, it, vi } from "vitest";
import { Tracewise } from "../src/index";

const trace = { model: "m", input: "i", output: "o", latency_ms: 1 };

function client(responses: (number | Error)[], opts: object = {}) {
	const calls: { events: unknown[] }[] = [];
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		calls.push(JSON.parse(init.body as string));
		const next = responses.length > 1 ? responses.shift()! : responses[0]!;
		if (next instanceof Error) throw next;
		return new Response(null, { status: next });
	});
	const tw = new Tracewise({ apiKey: "tw_x", endpoint: "https://api.example/", fetch: fetch as never, flushIntervalMs: 60_000, ...opts });
	return { tw, fetch, calls };
}

describe("Tracewise SDK", () => {
	afterEach(() => vi.useRealTimers());

	it("batches events and sends them with the key", async () => {
		const { tw, fetch, calls } = client([202], { maxBatch: 3 });
		for (let i = 0; i < 7; i++) tw.record(trace);
		await tw.shutdown();
		expect(calls.map((c) => c.events.length)).toEqual([3, 3, 1]);
		expect(fetch.mock.calls[0]![0]).toBe("https://api.example/v1/traces");
		expect((fetch.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer tw_x");
	});

	it("gives every event a unique id and timestamp", async () => {
		const { tw, calls } = client([202]);
		tw.record(trace);
		tw.record(trace);
		await tw.shutdown();
		const [a, b] = calls[0]!.events as { event_id: string; ts: string }[];
		expect(a!.event_id).not.toBe(b!.event_id);
		expect(a!.ts).toMatch(/Z$/);
	});

	it("retries 5xx, 429 and network errors, then succeeds", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const { tw, fetch } = client([503, 429, new Error("offline"), 202]);
		tw.record(trace);
		await tw.shutdown();
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(tw.dropped).toBe(0);
	});

	it("drops a batch the server rejects as invalid, without retrying", async () => {
		const onError = vi.fn();
		const { tw, fetch } = client([400], { onError });
		tw.record(trace);
		await tw.shutdown();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(tw.dropped).toBe(1);
		expect(onError).toHaveBeenCalled();
	});

	it("bounds memory by dropping the oldest events", () => {
		const { tw } = client([202], { maxBuffer: 5, maxBatch: 1000 });
		for (let i = 0; i < 8; i++) tw.record(trace);
		expect(tw.dropped).toBe(3);
	});

	it("applies redaction before anything leaves the process", async () => {
		const { tw, calls } = client([202]);
		const redacting = new Tracewise({
			apiKey: "k", endpoint: "https://api.example", flushIntervalMs: 60_000,
			fetch: (async (_u: string, init: RequestInit) => { calls.push(JSON.parse(init.body as string)); return new Response(null, { status: 202 }); }) as never,
			redact: (t) => ({ ...t, input: t.input.replace(/\S+@\S+/g, "[email]") }),
		});
		redacting.record({ ...trace, input: "contact me at jo@example.com" });
		await redacting.shutdown();
		await tw.shutdown();
		expect((calls[0]!.events[0] as { input: string }).input).toBe("contact me at [email]");
	});

	it("trace() records the call and returns its result unchanged, even on error", async () => {
		const { tw, calls } = client([202]);
		expect(await tw.trace({ model: "m", input: "q", output: (r: number) => String(r) }, async () => 42)).toBe(42);
		await expect(tw.trace({ model: "m", input: "q" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		await tw.shutdown();
		const [ok, failed] = calls[0]!.events as { output: string; status?: string }[];
		expect(ok!.output).toBe("42");
		expect(failed).toMatchObject({ status: "error", output: "Error: boom" });
	});

	it("never throws into the caller, even if redaction does", () => {
		const onError = vi.fn();
		const { tw } = client([202], { redact: () => { throw new Error("bad redactor"); }, onError });
		expect(() => tw.record(trace)).not.toThrow();
		expect(onError).toHaveBeenCalled();
	});
});
