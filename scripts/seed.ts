// Sends a week of realistic-looking demo traffic so analytics have something to show.
// Usage: node --env-file=.env.local --import tsx scripts/seed.ts [events]
export {};

const url = process.env.TRACEWISE_URL!;
const key = process.env.TRACEWISE_KEY!;
const total = Number(process.argv[2] ?? 2000);

// Per-million-token prices, roughly in line with hosted open-weight models.
const MODELS = [
	{ model: "llama-3.3-70b", provider: "workers-ai", inPrice: 0.29, outPrice: 2.25, latency: 900 },
	{ model: "claude-haiku", provider: "anthropic", inPrice: 1.0, outPrice: 5.0, latency: 700 },
	{ model: "gpt-oss-20b", provider: "workers-ai", inPrice: 0.2, outPrice: 0.3, latency: 450 },
];
const ROUTES = [
	{ route: "support-bot", weight: 5, model: 0, attackRate: 0.04 },
	{ route: "summarize-ticket", weight: 3, model: 2, attackRate: 0 },
	{ route: "sql-assistant", weight: 2, model: 1, attackRate: 0.01 },
	{ route: "onboarding-email", weight: 1, model: 1, attackRate: 0 },
];
const weights = ROUTES.flatMap((r, i) => Array(r.weight).fill(i) as number[]);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
// Log-normal-ish latency: most calls near typical, a long tail.
const latency = (typical: number) => Math.round(typical * Math.exp(0.45 * (Math.random() + Math.random() + Math.random() - 1.5) * 2));

const events = Array.from({ length: total }, () => {
	const r = ROUTES[pick(weights)]!;
	const m = MODELS[r.model]!;
	const daysAgo = Math.floor(Math.random() * 7);
	const ts = new Date(Date.now() - daysAgo * 86_400_000 - Math.random() * 3_600_000 * 8);
	const tokensIn = 200 + Math.floor(Math.random() * 1500);
	const blocked = Math.random() < r.attackRate;
	const tokensOut = blocked ? 0 : 50 + Math.floor(Math.random() * 400);
	const error = !blocked && Math.random() < 0.025;
	return {
		event_id: crypto.randomUUID(),
		ts: ts.toISOString(),
		model: m.model,
		provider: m.provider,
		route: r.route,
		input: "(demo input)",
		output: blocked ? "" : error ? "upstream timeout" : "(demo output)",
		status: error ? "error" : "ok",
		latency_ms: blocked ? 5 + Math.floor(Math.random() * 150) : latency(m.latency),
		tokens_in: tokensIn,
		tokens_out: tokensOut,
		cost_usd: blocked ? 0 : Number(((tokensIn * m.inPrice + tokensOut * m.outPrice) / 1e6).toFixed(8)),
		...(r.attackRate > 0 ? { security: { verdict: blocked ? "blocked" : "allowed", rules: blocked ? ["override-instructions"] : [] } } : {}),
	};
});

let sent = 0;
for (let i = 0; i < events.length; i += 100) {
	const res = await fetch(`${url}/v1/traces`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ events: events.slice(i, i + 100) }),
	});
	if (res.status !== 202) throw new Error(`batch ${i / 100}: HTTP ${res.status} ${await res.text()}`);
	sent += ((await res.json()) as { accepted: number }).accepted;
}
console.log(`sent ${sent} events across ${ROUTES.length} routes and 7 days`);
