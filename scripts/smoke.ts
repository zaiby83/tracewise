// End-to-end check against a deployed stack: sends traces through the SDK, waits for
// them to land, and checks auth, validation and idempotency on the way.
// Usage: node --env-file=.env.local --import tsx scripts/smoke.ts
import { Tracewise } from "../sdk/src/index";

const url = process.env.TRACEWISE_URL!;
const key = process.env.TRACEWISE_KEY!;
if (!url || !key) throw new Error("set TRACEWISE_URL and TRACEWISE_KEY");

const runId = crypto.randomUUID().slice(0, 8);
const N = 250;
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures++;
};

async function countRoute(route: string): Promise<number> {
	const res = await fetch(`${url}/v1/traces?day=${today}&limit=200`, { headers: { authorization: `Bearer ${key}` } });
	const body = (await res.json()) as { traces: { route?: string }[] };
	return body.traces.filter((t) => t.route === route).length;
}

// 1. Send N events through the SDK, as an app would.
const errors: unknown[] = [];
const tw = new Tracewise({ apiKey: key, endpoint: url, onError: (e) => errors.push(e) });
const started = performance.now();
for (let i = 0; i < N; i++) {
	tw.record({ model: "smoke-model", route: `smoke-${runId}`, input: `question ${i}`, output: `answer ${i}`, latency_ms: 100 + i, tokens_in: 12, tokens_out: 30 });
}
await tw.shutdown();
check(`SDK sent ${N} events`, errors.length === 0 && tw.dropped === 0, `${Math.round(performance.now() - started)} ms, ${errors.length} errors`);

// 2. They should become queryable shortly (async pipeline: API -> SQS -> Lambda -> DynamoDB).
const deadline = Date.now() + 30_000;
let seen = 0;
const waitStart = Date.now();
while (Date.now() < deadline && seen < Math.min(N, 200)) {
	await new Promise((r) => setTimeout(r, 1000));
	seen = await countRoute(`smoke-${runId}`);
}
check("events queryable", seen >= Math.min(N, 200), `${seen} visible after ${((Date.now() - waitStart) / 1000).toFixed(1)} s`);

// 3. Auth and validation.
const post = (body: unknown, auth = `Bearer ${key}`) =>
	fetch(`${url}/v1/traces`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
check("wrong key rejected", (await post({ events: [] }, `Bearer tw_${"x".repeat(43)}`)).status === 401);
check("garbage rejected", (await post({ events: [{ nope: 1 }] })).status === 400);

// 4. Idempotency: the same event sent three times is stored once.
const dupe = { event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "m", route: `dupe-${runId}`, input: "i", output: "o", latency_ms: 1 };
for (let i = 0; i < 3; i++) await post({ events: [dupe] });
// Low-traffic freshness is several seconds with the default batching window
// (docs/experiments.md, experiment 4), so poll until the event lands. Then give any
// stray copy a few more seconds to show up before counting.
const dupeDeadline = Date.now() + 30_000;
let copies = 0;
while (Date.now() < dupeDeadline && copies === 0) {
	await new Promise((r) => setTimeout(r, 1000));
	copies = await countRoute(`dupe-${runId}`);
}
if (copies > 0) {
	await new Promise((r) => setTimeout(r, 3000));
	copies = await countRoute(`dupe-${runId}`);
}
check("duplicate deliveries stored once", copies === 1, `${copies} stored`);

process.exit(failures ? 1 : 0);
