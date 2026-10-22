// Number and date formatting for the dashboard. Pure: no DOM access, so it runs in Node too.

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const int = new Intl.NumberFormat("en");
export const fmtCalls = (n) => (n >= 10_000 ? compact.format(n) : int.format(n));
export const fmtCost = (n) => (n === 0 ? "$0" : n >= 100 ? `$${compact.format(n)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 0.01 ? 4 : 3)}`);
export const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
export const fmtPct = (n) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
export const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
export const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function niceMax(v) {
	if (v <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
