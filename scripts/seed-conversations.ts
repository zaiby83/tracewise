// Sends the labelled conversations in eval/conversations.json as real traffic, so the
// evaluation workflow has meaningful content to grade.
// Usage: node --env-file=.env.local --import tsx scripts/seed-conversations.ts [copies] [day] [mix]
//   day: YYYY-MM-DD to stamp the traffic with (default today)
//   mix: "all" (default), "good", or a share of bad answers like "0.8"
import { readFile } from "node:fs/promises";

const url = process.env.TRACEWISE_URL!;
const key = process.env.TRACEWISE_DEMO_KEY ?? process.env.TRACEWISE_KEY!;
const copies = Number(process.argv[2] ?? 1);
const day = process.argv[3];
const mix = process.argv[4] ?? "all";
const cases = JSON.parse(await readFile(new URL("../eval/conversations.json", import.meta.url), "utf8")) as {
	route: string;
	input: string;
	output: string;
	label: string;
	kind: string;
}[];

const good = cases.filter((c) => c.label === "good");
const bad = cases.filter((c) => c.label === "bad");
// "all": every labelled case once. "good": healthy answers only. A number p: 20
// conversations of which a share p are bad answers (0.1 for a normal day, 0.7 for a
// bad deploy).
const cycle = <T>(xs: T[], n: number) => Array.from({ length: n }, (_, i) => xs[i % xs.length]!);
const pool =
	mix === "all" ? cases
	: mix === "good" ? good
	: [...cycle(bad, Math.round(20 * Number(mix))), ...cycle(good, 20 - Math.round(20 * Number(mix)))];
const tsFor = () =>
	day ? new Date(`${day}T${String(9 + Math.floor(Math.random() * 8)).padStart(2, "0")}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}:00Z`).toISOString() : new Date().toISOString();

const events = Array.from({ length: copies }).flatMap(() =>
	pool.map((c) => ({
		event_id: crypto.randomUUID(),
		ts: tsFor(),
		model: "llama-3.3-70b",
		provider: "workers-ai",
		route: c.route,
		input: c.input,
		output: c.output,
		latency_ms: 400 + Math.floor(Math.random() * 900),
		tokens_in: 120,
		tokens_out: 90,
		// The human label rides along as metadata, so eval results can be checked against it.
		metadata: { label: c.label, kind: c.kind },
	})),
);

for (let i = 0; i < events.length; i += 100) {
	const res = await fetch(`${url}/v1/traces`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ events: events.slice(i, i + 100) }),
	});
	if (res.status !== 202) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}
console.log(`sent ${events.length} labelled conversations`);
