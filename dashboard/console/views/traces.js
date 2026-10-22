// Traces and analytics for the current org: the demo dashboard's tiles, charts and tables,
// drawn by the shared code and fed from the console's JWT routes.

import { el } from "../../shared/dom.js";
import { fmtCalls, fmtCost, fmtMs, fmtPct, int, niceMax, shortDay, sum } from "../../shared/format.js";
import { columnChart, lineChart, magnitude, table, tile } from "../../shared/charts.js";
import { cardHead, errorLine, pageHead, showError } from "../ui.js";

const RANGES = [7, 30];
const LOW = 3;

// The latest run per evaluated day, oldest first.
function runsByDay(runs) {
	const latest = new Map();
	for (const r of runs) if (!latest.has(r.day) || latest.get(r.day).run_at < r.run_at) latest.set(r.day, r);
	return [...latest.values()].filter((r) => typeof r.meanOverall === "number").sort((a, b) => a.day.localeCompare(b.day));
}

// A chart with its "view as table" fallback. Returns the card plus the two slots to fill.
function chartCard(title) {
	const chart = el("div", { class: "chart" });
	const rows = el("div");
	return { card: el("section", { class: "card" }, cardHead(title), chart, el("details", {}, el("summary", {}, "View as table"), rows)), chart, rows };
}

function traceRows(traces) {
	const out = [];
	for (const t of traces) {
		const status = t.security?.verdict === "blocked" ? ["bad", "Blocked"] : t.status === "error" ? ["warn", "Error"] : ["ok", "OK"];
		const detail = el("tr", { class: "detail", hidden: true }, el("td", { colspan: 6 }, el("div", { class: "io" }, el("div", {}, el("div", { class: "k" }, "Input"), el("pre", {}, t.input)), el("div", {}, el("div", { class: "k" }, "Output"), el("pre", {}, t.output || "(none)")))));
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
		out.push(row, detail);
	}
	return out;
}

export async function render(root, ctx) {
	const base = `/v1/orgs/${ctx.org.org_id}`;
	let days = 7;
	let data = null;

	const tiles = el("section", { class: "tiles", "aria-label": "Summary" });
	const quality = chartCard("Answer quality");
	const latency = chartCard("95th-percentile latency");
	const calls = chartCard("Calls per day");
	const cost = chartCard("Model spend per day");
	const routes = el("div", { class: "table-wrap" });
	const worstDay = el("p", { class: "sub" });
	const worst = el("ul", { class: "worst" });
	const tracesDay = el("p", { class: "sub" });
	const traces = el("div", { class: "table-wrap" });
	const error = errorLine();
	const buttons = RANGES.map((n) => el("button", { class: "range", type: "button", "aria-pressed": String(n === days), onclick: () => load(n) }, `${n} days`));

	async function recentTraces() {
		// Today's traces, or yesterday's if today is still empty.
		const day = (ago) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
		const first = await ctx.api.get(`${base}/traces?limit=25&day=${day(0)}`);
		return first.traces.length ? first : ctx.api.get(`${base}/traces?limit=25&day=${day(1)}`);
	}

	function draw() {
		const { summary, evals, recent } = data;
		const byDay = summary.byDay;
		const total = sum(byDay, (d) => d.calls);
		const spend = sum(byDay, (d) => d.cost_usd);
		const errors = sum(byDay, (d) => d.errors);
		const runs = runsByDay(evals.runs);
		const latest = runs.at(-1);

		tiles.replaceChildren(
			tile("Calls", fmtCalls(total), `last ${days} days`, { trend: byDay.map((d) => d.calls) }),
			tile("Model spend", fmtCost(spend), total ? `${fmtCost(spend / total)} per call` : null, { trend: byDay.map((d) => d.cost_usd) }),
			tile("Error rate", total ? fmtPct(errors / total) : "–", `${int.format(errors)} failed calls`, { trend: byDay.map((d) => (d.calls ? d.errors / d.calls : 0)) }),
			tile("Attacks blocked", int.format(sum(byDay, (d) => d.blocked)), "by Prompt Shield", { trend: byDay.map((d) => d.blocked) }),
			latest
				? tile("Answer quality", `${latest.meanOverall.toFixed(2)} / 5`, `judged ${shortDay(latest.day)}`, { flag: latest.regressed ? { kind: "bad", text: "Regression vs last week" } : { kind: "ok", text: "Within normal range" }, trend: runs.map((r) => r.meanOverall) })
				: tile("Answer quality", "–", "no evaluation yet"),
		);

		lineChart(quality.chart, runs.map((r) => ({ ...r, value: r.meanOverall })), {
			min: 1,
			max: 5,
			ticks: [1, 2, 3, 4, 5],
			format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2)),
			label: "Answer quality",
			emptyText: "No evaluation runs yet. The judge runs nightly.",
			flag: (r) => (r.regressed ? "▲ Regression" : null),
			tip: (r) => ({ value: `${r.meanOverall.toFixed(2)} / 5`, label: `${shortDay(r.day)} · ${r.scored} graded${r.safetyFailures ? ` · ${r.safetyFailures} safety failures` : ""}${r.regressed ? " · regression" : ""}` }),
		});
		const latencyMax = niceMax(Math.max(1, ...byDay.map((d) => d.p95_ms)));
		lineChart(latency.chart, byDay.map((d) => ({ ...d, value: d.p95_ms })), {
			min: 0,
			max: latencyMax,
			ticks: [0, latencyMax / 2, latencyMax],
			format: fmtMs,
			label: "95th-percentile latency",
			emptyText: "No data in this range yet.",
			tip: (d) => ({ value: `${fmtMs(d.p95_ms)} p95`, label: `${shortDay(d.day)} · ${int.format(d.calls)} calls` }),
		});
		columnChart(calls.chart, byDay.map((d) => ({ day: d.day, value: d.calls })), { label: "Calls per day", format: fmtCalls, tip: (p) => ({ value: `${int.format(p.value)} calls`, label: shortDay(p.day) }) });
		columnChart(cost.chart, byDay.map((d) => ({ day: d.day, value: d.cost_usd })), { label: "Model spend per day", format: fmtCost, tip: (p) => ({ value: fmtCost(p.value), label: shortDay(p.day) }) });

		quality.rows.replaceChildren(table([["Day"], ["Mean score", 1], ["Graded", 1], ["Safety failures", 1], ["Regression"]], runs.map((r) => [[r.day], [r.meanOverall.toFixed(2), 1], [r.scored, 1], [r.safetyFailures, 1], [r.regressed ? "Yes" : "No"]])));
		latency.rows.replaceChildren(table([["Day"], ["p95 latency", 1], ["Calls", 1]], byDay.map((d) => [[d.day], [fmtMs(d.p95_ms), 1], [int.format(d.calls), 1]])));
		calls.rows.replaceChildren(table([["Day"], ["Calls", 1], ["Errors", 1], ["Blocked", 1]], byDay.map((d) => [[d.day], [int.format(d.calls), 1], [d.errors, 1], [d.blocked, 1]])));
		cost.rows.replaceChildren(table([["Day"], ["Spend", 1]], byDay.map((d) => [[d.day], [fmtCost(d.cost_usd), 1]])));

		const maxCalls = Math.max(1, ...summary.byRoute.map((r) => r.calls));
		const maxCost = Math.max(1e-9, ...summary.byRoute.map((r) => r.cost_usd));
		routes.replaceChildren(
			summary.byRoute.length
				? table(
						[["Route"], ["Model"], ["Calls", 1], ["p50", 1], ["p95", 1], ["Spend", 1], ["Errors", 1], ["Blocked", 1]],
						summary.byRoute.map((r) => [[el("span", { class: "route-name" }, r.route)], [r.model], [magnitude(int.format(r.calls), r.calls / maxCalls), 1], [fmtMs(r.p50_ms), 1], [fmtMs(r.p95_ms), 1], [magnitude(fmtCost(r.cost_usd), r.cost_usd / maxCost), 1], [fmtPct(r.error_rate), 1], [r.blocked, 1]]),
					)
				: el("p", { class: "empty" }, "No traffic in this range yet."),
		);

		// Only genuinely poor answers from the latest evaluated day.
		const low = latest ? latest.worst.filter((w) => w.overall < LOW) : [];
		worstDay.textContent = latest ? `Below ${LOW}/5 in the evaluation of ${shortDay(latest.day)}` : "";
		worst.replaceChildren(
			...(!latest
				? [el("li", { class: "none" }, "No evaluations yet.")]
				: low.length
					? low.map((w) => el("li", {}, el("span", { class: `score pill ${w.overall < 2 ? "bad" : "warn"}` }, el("span", { class: "dot", "aria-hidden": "true" }), w.overall.toFixed(1)), el("span", { class: "route" }, w.route), el("span", { class: "reason" }, w.reason)))
					: [el("li", { class: "none" }, `No answers scored below ${LOW}/5 in the latest evaluation.`)]),
		);

		tracesDay.textContent = recent.day ? `${shortDay(recent.day)} · select a row to see the conversation` : "";
		const rows = traceRows(recent.traces);
		traces.replaceChildren(
			rows.length ? el("table", {}, el("thead", {}, el("tr", {}, ["Time", "Route", "Model", "Latency", "Cost", "Status"].map((h, i) => el("th", { class: i === 3 || i === 4 ? "num" : null, scope: "col" }, h)))), el("tbody", {}, rows)) : el("p", { class: "empty" }, "No traces today or yesterday."),
		);
	}

	async function load(range = days) {
		days = range;
		buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(RANGES[i] === days)));
		showError(error, "");
		// A capped analytics query shouldn't hide the traces, so each call fails on its own and the
		// banner says which went wrong.
		const [summary, evals, recent] = await Promise.allSettled([ctx.api.get(`${base}/analytics/summary?days=${days}`), ctx.api.get(`${base}/evals?limit=30`), recentTraces()]);
		const failed = [summary, evals, recent].find((r) => r.status === "rejected");
		if (failed) showError(error, failed.reason.message);
		const got = (r, fallback) => (r.status === "fulfilled" ? r.value : fallback);
		data = { summary: got(summary, { byDay: [], byRoute: [] }), evals: got(evals, { runs: [] }), recent: got(recent, { day: null, traces: [] }) };
		draw();
	}

	root.replaceChildren(
		pageHead("Traces & analytics", `Your own traffic in ${ctx.org.name}.`),
		el("div", { class: "toolbar" }, el("div", { class: "segmented" }, ...buttons), el("button", { class: "button", type: "button", onclick: () => load() }, "Refresh")),
		error,
		tiles,
		el("section", { class: "grid" }, quality.card, latency.card, calls.card, cost.card),
		el("section", { class: "card" }, cardHead("Routes"), routes),
		el("section", { class: "card" }, el("header", { class: "card-head" }, el("h2", {}, "Lowest-scoring answers"), worstDay), worst),
		el("section", { class: "card" }, el("header", { class: "card-head" }, el("h2", {}, "Recent traces"), tracesDay), traces),
	);
	await load();

	// Charts are drawn at the width they are given, so redraw when the window changes size,
	// until this view has been replaced.
	let timer;
	const onResize = () => {
		if (!root.isConnected) return window.removeEventListener("resize", onResize);
		clearTimeout(timer);
		timer = setTimeout(() => data && draw(), 150);
	};
	window.addEventListener("resize", onResize);
}
