export {};
// Measures pipeline latency: sends events one at a time and reports how long each
// took from API acceptance (received_at) to being written (processed_at).
// Usage: node --env-file=.env.local --import tsx scripts/latency.ts [samples]
const url = process.env.TRACEWISE_URL!;
const key = process.env.TRACEWISE_KEY!;
const samples = Number(process.argv[2] ?? 20);
const auth = { authorization: `Bearer ${key}` };
const route = `latency-${crypto.randomUUID().slice(0, 8)}`;

for (let i = 0; i < samples; i++) {
	const event = { event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "m", route, input: "i", output: "o", latency_ms: 1 };
	await fetch(`${url}/v1/traces`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) });
	// Spread the samples out so each one meets an idle-ish queue, as low traffic would.
	await new Promise((r) => setTimeout(r, 3000));
}
await new Promise((r) => setTimeout(r, 30_000));

const res = await fetch(`${url}/v1/traces?limit=200`, { headers: auth });
const traces = ((await res.json()) as { traces: { route: string; received_at: string; processed_at?: string }[] }).traces.filter((t) => t.route === route && t.processed_at);
const ms = traces.map((t) => Date.parse(t.processed_at!) - Date.parse(t.received_at)).sort((a, b) => a - b);
const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))]!;
console.log(JSON.stringify({ samples: ms.length, p50_ms: pct(50), p90_ms: pct(90), max_ms: ms.at(-1), all_ms: ms }));
