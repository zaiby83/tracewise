// Open-loop load generator: sends batches on a fixed schedule whether or not earlier
// requests have finished, so a slow server can't quietly slow the test down and hide
// its own latency (coordinated omission).
// Usage: node --env-file=.env.local --import tsx scripts/loadtest.ts "1000x300,5000x60" [batch]
//   phases: <events per second>x<seconds>, comma-separated
export {};

const url = process.env.TRACEWISE_URL!;
const key = process.env.TRACEWISE_LOADTEST_KEY!;
if (!url || !key) throw new Error("set TRACEWISE_URL and TRACEWISE_LOADTEST_KEY");
const phases = (process.argv[2] ?? "1000x60").split(",").map((p) => {
	const [rate, secs] = p.split("x").map(Number);
	return { rate: rate!, secs: secs! };
});
const BATCH = Number(process.argv[3] ?? 50);
const MAX_IN_FLIGHT = 1000;

const runId = `load-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;
const text = "How do I connect a custom domain and enable HTTPS for my site? ".repeat(4);

function batch(n: number) {
	const ts = new Date().toISOString();
	return JSON.stringify({
		events: Array.from({ length: n }, () => ({
			event_id: crypto.randomUUID(),
			ts,
			model: "llama-3.3-70b",
			route: runId,
			input: text,
			output: text,
			latency_ms: 500,
			tokens_in: 60,
			tokens_out: 60,
			cost_usd: 0.0001,
		})),
	});
}

interface Phase {
	rate: number;
	secs: number;
	sentEvents: number;
	accepted: number;
	statuses: Record<string, number>;
	latencies: number[];
	skipped: number;
}

const results: Phase[] = [];
let inFlight = 0;

for (const { rate, secs } of phases) {
	const phase: Phase = { rate, secs, sentEvents: 0, accepted: 0, statuses: {}, latencies: [], skipped: 0 };
	results.push(phase);
	const requestsPerSec = rate / BATCH;
	const start = performance.now();
	const pending: Promise<void>[] = [];
	let issued = 0;
	console.error(`phase: ${rate} events/s for ${secs} s (${requestsPerSec} req/s of ${BATCH})`);

	while (performance.now() - start < secs * 1000) {
		const due = Math.floor(((performance.now() - start) / 1000) * requestsPerSec);
		while (issued < due) {
			issued++;
			if (inFlight >= MAX_IN_FLIGHT) {
				phase.skipped++; // generator saturated: reported, never hidden
				continue;
			}
			inFlight++;
			phase.sentEvents += BATCH;
			const t0 = performance.now();
			pending.push(
				fetch(`${url}/v1/traces`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: batch(BATCH) })
					.then(async (res) => {
						phase.latencies.push(performance.now() - t0);
						phase.statuses[res.status] = (phase.statuses[res.status] ?? 0) + 1;
						if (res.status === 202) phase.accepted += ((await res.json()) as { accepted: number }).accepted;
						else await res.arrayBuffer();
					})
					.catch((err) => {
						phase.statuses[`network:${(err as Error).cause ?? (err as Error).message}`.slice(0, 40)] = (phase.statuses[`network`] ?? 0) + 1;
					})
					.finally(() => inFlight--),
			);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	await Promise.all(pending);
	const elapsed = (performance.now() - start) / 1000;
	const l = phase.latencies.sort((a, b) => a - b);
	const p = (q: number) => Math.round(l[Math.min(l.length - 1, Math.floor(q * l.length))] ?? NaN);
	console.error(
		`  sent ${phase.sentEvents} events, accepted ${phase.accepted} (${Math.round(phase.accepted / elapsed)}/s), statuses ${JSON.stringify(phase.statuses)}, client latency p50 ${p(0.5)} p95 ${p(0.95)} p99 ${p(0.99)} max ${Math.round(l.at(-1) ?? NaN)} ms, skipped ${phase.skipped}`,
	);
}

console.log(
	JSON.stringify({
		runId,
		batch: BATCH,
		phases: results.map(({ latencies, ...r }) => {
			const l = [...latencies].sort((a, b) => a - b);
			const p = (q: number) => Math.round(l[Math.min(l.length - 1, Math.floor(q * l.length))] ?? NaN);
			return { ...r, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(l.at(-1) ?? NaN) };
		}),
		finishedAt: new Date().toISOString(),
	}),
);
