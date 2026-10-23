// Tracewise dashboard. Plain DOM and SVG, no dependencies.
// Every value from the API is inserted with textContent: trace content is
// customer-controlled and must never be interpreted as HTML.

import { $, el, storage } from "./shared/dom.js";
import { fmtCalls, fmtCost, fmtMs, fmtPct, int, niceMax, shortDay, sum } from "./shared/format.js";
import { columnChart, lineChart, magnitude, table, tile } from "./shared/charts.js";

const KEY_STORAGE = "tracewise_key";
const THEME_STORAGE = "tracewise_theme";
// Matches CloudFront's API cache TTL, so an auto-refresh rarely reaches the origin.
const REFRESH_MS = 60_000;

let config = { demoKey: "" };
let days = 7;
let data = null;
let lastLoaded = 0;
let loading = false;

// ---- Theme ------------------------------------------------------------------------------

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const currentTheme = () => document.documentElement.dataset.theme || (prefersDark() ? "dark" : "light");

function applyTheme(theme) {
	if (theme) document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
	$("theme-button").setAttribute("aria-label", `Switch to ${currentTheme() === "dark" ? "light" : "dark"} theme`);
}

// ---- API --------------------------------------------------------------------------------

const apiKey = () => storage.get(sessionStorage, KEY_STORAGE) || config.demoKey;
const usingDemo = () => apiKey() === config.demoKey;

async function api(path) {
	const res = await fetch(path, { headers: { authorization: `Bearer ${apiKey()}` } });
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
	return body;
}

async function recentTraces() {
	// Today's traces, or yesterday's if today is still empty.
	const today = new Date().toISOString().slice(0, 10);
	const first = await api(`/v1/traces?limit=25&day=${today}`);
	if (first.traces.length) return first;
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	return api(`/v1/traces?limit=25&day=${yesterday}`);
}


// ---- Rendering --------------------------------------------------------------------------


// The latest run per evaluated day, oldest first.
function runsByDay(runs) {
	const latest = new Map();
	for (const r of runs) if (!latest.has(r.day) || latest.get(r.day).run_at < r.run_at) latest.set(r.day, r);
	return [...latest.values()].filter((r) => typeof r.meanOverall === "number").sort((a, b) => a.day.localeCompare(b.day));
}

function render() {
	if (!data) return;
	const { summary, evals, traces } = data;
	const byDay = summary.byDay;
	const calls = sum(byDay, (d) => d.calls);
	const cost = sum(byDay, (d) => d.cost_usd);
	const errors = sum(byDay, (d) => d.errors);
	const blocked = sum(byDay, (d) => d.blocked);
	const runs = runsByDay(evals.runs);
	const latest = runs.at(-1);

	$("tiles").replaceChildren(
		tile("Calls", fmtCalls(calls), `last ${days} days`, { trend: byDay.map((d) => d.calls) }),
		tile("Model spend", fmtCost(cost), calls ? `${fmtCost(cost / calls)} per call` : null, { trend: byDay.map((d) => d.cost_usd) }),
		tile("Error rate", calls ? fmtPct(errors / calls) : "–", `${int.format(errors)} failed calls`, { trend: byDay.map((d) => (d.calls ? d.errors / d.calls : 0)) }),
		tile("Attacks blocked", int.format(blocked), "by Prompt Shield", { trend: byDay.map((d) => d.blocked) }),
		latest
			? tile("Answer quality", `${latest.meanOverall.toFixed(2)} / 5`, `judged ${shortDay(latest.day)}`, {
					flag: latest.regressed ? { kind: "bad", text: "Regression vs last week" } : { kind: "ok", text: "Within normal range" },
					trend: runs.map((r) => r.meanOverall),
				})
			: tile("Answer quality", "–", "no evaluation yet"),
	);

	lineChart($("chart-quality"), runs.map((r) => ({ ...r, value: r.meanOverall })), {
		min: 1,
		max: 5,
		ticks: [1, 2, 3, 4, 5],
		format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2)),
		label: "Answer quality",
		emptyText: "No evaluation runs yet. The judge runs nightly at 06:00 UTC.",
		flag: (r) => (r.regressed ? "▲ Regression" : null),
		tip: (r) => ({ value: `${r.meanOverall.toFixed(2)} / 5`, label: `${shortDay(r.day)} · ${r.scored} graded${r.safetyFailures ? ` · ${r.safetyFailures} safety failures` : ""}${r.regressed ? " · regression" : ""}` }),
	});

	const latencyMax = niceMax(Math.max(1, ...byDay.map((d) => d.p95_ms)));
	lineChart($("chart-latency"), byDay.map((d) => ({ ...d, value: d.p95_ms })), {
		min: 0,
		max: latencyMax,
		ticks: [0, latencyMax / 2, latencyMax],
		format: fmtMs,
		label: "95th-percentile latency",
		emptyText: "No data in this range yet.",
		tip: (d) => ({ value: `${fmtMs(d.p95_ms)} p95`, label: `${shortDay(d.day)} · ${int.format(d.calls)} calls` }),
	});

	columnChart($("chart-calls"), byDay.map((d) => ({ day: d.day, value: d.calls })), {
		label: "Calls per day",
		format: fmtCalls,
		tip: (p) => ({ value: `${int.format(p.value)} calls`, label: shortDay(p.day) }),
	});
	columnChart($("chart-cost"), byDay.map((d) => ({ day: d.day, value: d.cost_usd })), {
		label: "Model spend per day",
		format: fmtCost,
		tip: (p) => ({ value: fmtCost(p.value), label: shortDay(p.day) }),
	});

	$("table-quality").replaceChildren(table([["Day"], ["Mean score", 1], ["Graded", 1], ["Safety failures", 1], ["Regression"]], runs.map((r) => [[r.day], [r.meanOverall.toFixed(2), 1], [r.scored, 1], [r.safetyFailures, 1], [r.regressed ? "Yes" : "No"]])));
	$("table-latency").replaceChildren(table([["Day"], ["p95 latency", 1], ["Calls", 1]], byDay.map((d) => [[d.day], [fmtMs(d.p95_ms), 1], [int.format(d.calls), 1]])));
	$("table-calls").replaceChildren(table([["Day"], ["Calls", 1], ["Errors", 1], ["Blocked", 1]], byDay.map((d) => [[d.day], [int.format(d.calls), 1], [d.errors, 1], [d.blocked, 1]])));
	$("table-cost").replaceChildren(table([["Day"], ["Spend", 1]], byDay.map((d) => [[d.day], [fmtCost(d.cost_usd), 1]])));

	const maxCalls = Math.max(1, ...summary.byRoute.map((r) => r.calls));
	const maxCost = Math.max(1e-9, ...summary.byRoute.map((r) => r.cost_usd));
	$("routes").replaceChildren(
		summary.byRoute.length
			? el(
					"table",
					{},
					el("thead", {}, el("tr", {}, [["Route"], ["Model"], ["Calls", 1], ["p50", 1], ["p95", 1], ["Spend", 1], ["Errors", 1], ["Blocked", 1]].map(([h, n]) => el("th", { class: n ? "num" : null, scope: "col" }, h)))),
					el(
						"tbody",
						{},
						summary.byRoute.map((r) =>
							el(
								"tr",
								{},
								el("td", { class: "route-name" }, r.route),
								el("td", {}, r.model),
								el("td", { class: "num" }, magnitude(int.format(r.calls), r.calls / maxCalls)),
								el("td", { class: "num" }, fmtMs(r.p50_ms)),
								el("td", { class: "num" }, fmtMs(r.p95_ms)),
								el("td", { class: "num" }, magnitude(fmtCost(r.cost_usd), r.cost_usd / maxCost)),
								el("td", { class: "num" }, fmtPct(r.error_rate)),
								el("td", { class: "num" }, r.blocked),
							),
						),
					),
				)
			: el("p", { class: "empty" }, "No traffic in this range yet."),
	);

	// Only genuinely poor answers (below 3/5) from the latest evaluated day.
	const LOW = 3;
	const low = latest ? latest.worst.filter((w) => w.overall < LOW) : [];
	$("worst-day").textContent = latest ? `Below ${LOW}/5 in the evaluation of ${shortDay(latest.day)}` : "";
	$("worst").replaceChildren(
		...(!latest
			? [el("li", { class: "none" }, "No evaluations yet.")]
			: low.length
				? low.map((w) =>
						el(
							"li",
							{},
							el("span", { class: `score pill ${w.overall < 2 ? "bad" : "warn"}` }, el("span", { class: "dot", "aria-hidden": "true" }), `${w.overall.toFixed(1)}`),
							el("span", { class: "route" }, w.route),
							el("span", { class: "reason" }, w.reason),
						),
					)
				: [el("li", { class: "none" }, `No answers scored below ${LOW}/5 in the latest evaluation.`)]),
	);

	$("traces-day").textContent = traces.day ? `${shortDay(traces.day)} · select a row to see the conversation` : "";
	const rows = [];
	for (const t of traces.traces) {
		const status = t.security?.verdict === "blocked" ? ["bad", "Blocked"] : t.status === "error" ? ["warn", "Error"] : ["ok", "OK"];
		const detail = el(
			"tr",
			{ class: "detail", hidden: true },
			el("td", { colspan: 6 }, el("div", { class: "io" }, el("div", {}, el("div", { class: "k" }, "Input"), el("pre", {}, t.input)), el("div", {}, el("div", { class: "k" }, "Output"), el("pre", {}, t.output || "(none)")))),
		);
		const row = el(
			"tr",
			{ class: "trace", tabindex: 0, "aria-expanded": "false" },
			el("td", {}, new Date(t.ts).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })),
			el("td", {}, t.route ?? "–"),
			el("td", {}, t.model),
			el("td", { class: "num" }, fmtMs(t.latency_ms)),
			el("td", { class: "num" }, t.cost_usd != null ? fmtCost(t.cost_usd) : "–"),
			el("td", {}, el("span", { class: `pill ${status[0]}` }, el("span", { class: "dot", "aria-hidden": "true" }), status[1])),
		);
		const toggle = () => {
			detail.hidden = !detail.hidden;
			row.setAttribute("aria-expanded", String(!detail.hidden));
		};
		row.addEventListener("click", toggle);
		row.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				toggle();
			}
		});
		rows.push(row, detail);
	}
	$("traces").replaceChildren(
		rows.length
			? el(
					"table",
					{},
					el("thead", {}, el("tr", {}, ["Time", "Route", "Model", "Latency", "Cost", "Status"].map((h, i) => el("th", { class: i === 3 || i === 4 ? "num" : null, scope: "col" }, h)))),
					el("tbody", {}, rows),
				)
			: el("p", { class: "empty" }, "No traces today or yesterday."),
	);
}

// ---- Loading & freshness -------------------------------------------------------------------

function updateFreshness() {
	if (loading) return;
	if (!lastLoaded) return;
	const secs = Math.round((Date.now() - lastLoaded) / 1000);
	$("status").textContent = `Live · updated ${secs < 10 ? "just now" : secs < 60 ? `${secs} s ago` : `${Math.round(secs / 60)} min ago`}`;
}

async function load() {
	if (loading) return;
	loading = true;
	document.body.classList.add("loading");
	$("refresh-button").classList.add("spinning");
	$("status").textContent = "Updating…";
	try {
		const [me, summary, evals, traces] = await Promise.all([api("/v1/me"), api(`/v1/analytics/summary?days=${days}`), api("/v1/evals?limit=30"), recentTraces()]);
		data = { summary, evals, traces };
		$("tenant-name").textContent = me.name;
		const badge = $("mode-badge");
		badge.hidden = false;
		badge.textContent = usingDemo() ? "Demo data · read-only" : me.scope === "read" ? "Read-only key" : "Your key";
		$("key-button").textContent = usingDemo() ? "Use your own key" : "Change key";
		$("error").hidden = true;
		render();
		lastLoaded = Date.now();
	} catch (err) {
		$("error-text").textContent =
			err.status === 401 ? "That API key isn't valid." : err.status === 429 ? "Too many requests right now. Try again in a minute." : `Couldn't load the dashboard (${err.message}).`;
		$("error").hidden = false;
		if (err.status === 401 && !usingDemo()) storage.set(sessionStorage, KEY_STORAGE, null);
	} finally {
		loading = false;
		document.body.classList.remove("loading", "first-load");
		$("refresh-button").classList.remove("spinning");
		updateFreshness();
	}
}

function wire() {
	applyTheme(storage.get(localStorage, THEME_STORAGE));
	$("theme-button").addEventListener("click", () => {
		const next = currentTheme() === "dark" ? "light" : "dark";
		storage.set(localStorage, THEME_STORAGE, next);
		applyTheme(next);
	});
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(document.documentElement.dataset.theme));

	for (const b of document.querySelectorAll(".range")) {
		b.addEventListener("click", () => {
			days = Number(b.dataset.days);
			for (const o of document.querySelectorAll(".range")) o.setAttribute("aria-pressed", String(o === b));
			load();
		});
	}
	$("refresh-button").addEventListener("click", load);
	$("retry-button").addEventListener("click", load);

	// Auto-refresh while the tab is visible; catch up when it becomes visible again.
	setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && Date.now() - lastLoaded > REFRESH_MS) load();
	});
	setInterval(updateFreshness, 5000);

	const dialog = $("key-dialog");
	$("key-button").addEventListener("click", () => {
		$("key-error").hidden = true;
		$("key-input").value = "";
		dialog.showModal();
	});
	$("key-cancel").addEventListener("click", () => dialog.close());
	$("key-demo").addEventListener("click", () => {
		storage.set(sessionStorage, KEY_STORAGE, null);
		dialog.close();
		load();
	});
	$("key-form").addEventListener("submit", (e) => {
		const key = $("key-input").value.trim();
		if (!/^tw_[A-Za-z0-9_-]{43}$/.test(key)) {
			e.preventDefault();
			$("key-error").textContent = "That doesn't look like a Tracewise key (tw_ followed by 43 characters).";
			$("key-error").hidden = false;
			return;
		}
		storage.set(sessionStorage, KEY_STORAGE, key);
		load();
	});

	let resize;
	window.addEventListener("resize", () => {
		clearTimeout(resize);
		resize = setTimeout(render, 150);
	});
}

async function main() {
	wire();
	try {
		config = await (await fetch("config.json")).json();
	} catch {
		$("error-text").textContent = "Missing configuration.";
		$("error").hidden = false;
	}
	load();
}
main();
