// Tracewise dashboard. Plain DOM and SVG, no dependencies.
// Every value from the API is inserted with textContent: trace content is
// customer-controlled and must never be interpreted as HTML.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const KEY_STORAGE = "tracewise_key";
const THEME_STORAGE = "tracewise_theme";
// Matches CloudFront's API cache TTL, so an auto-refresh rarely reaches the origin.
const REFRESH_MS = 60_000;

let config = { demoKey: "" };
let days = 7;
let data = null;
let lastLoaded = 0;
let loading = false;

// ---- Small helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
	const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return node;
}

const storage = {
	get: (s, k) => {
		try {
			return s.getItem(k);
		} catch {
			return null;
		}
	},
	set: (s, k, v) => {
		try {
			v === null ? s.removeItem(k) : s.setItem(k, v);
		} catch {}
	},
};

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const int = new Intl.NumberFormat("en");
const fmtCalls = (n) => (n >= 10_000 ? compact.format(n) : int.format(n));
const fmtCost = (n) => (n === 0 ? "$0" : n >= 100 ? `$${compact.format(n)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 0.01 ? 4 : 3)}`);
const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const fmtPct = (n) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
const shortDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);

function niceMax(v) {
	if (v <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

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

// ---- Tooltip ----------------------------------------------------------------------------

function showTip(x, y, value, label) {
	const t = $("tooltip");
	t.replaceChildren(el("div", { class: "tv" }, value), el("div", { class: "tl" }, label));
	t.hidden = false;
	const { width, height } = t.getBoundingClientRect();
	t.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2))}px`;
	t.style.top = `${Math.max(8, y - height - 12)}px`;
}
const hideTip = () => ($("tooltip").hidden = true);

// ---- Charts -----------------------------------------------------------------------------

const M = { top: 14, right: 14, bottom: 28, left: 48 };

function frame(container, height) {
	const width = Math.max(260, container.clientWidth || 600);
	const svg = el("svg:svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
	return { svg, width, height, plotW: width - M.left - M.right, plotH: height - M.top - M.bottom };
}

function yAxis(f, ticks, min, max, format) {
	for (const t of ticks) {
		const y = M.top + f.plotH - ((t - min) / (max - min)) * f.plotH;
		f.svg.append(el("svg:line", { class: t === min ? "baseline" : "gridline", x1: M.left, x2: M.left + f.plotW, y1: y, y2: y }));
		f.svg.append(el("svg:text", { class: "tick", x: M.left - 8, y: y + 4, "text-anchor": "end" }, format(t)));
	}
}

const empty = (container, text) => container.replaceChildren(el("p", { class: "empty" }, text));

// Single-series column chart: one colour, no legend (the card title names the series).
function columnChart(container, points, { format, label, tip }) {
	if (!points.length) return empty(container, "No data in this range yet.");
	const f = frame(container, 210);
	const max = niceMax(Math.max(...points.map((p) => p.value)));
	f.svg.setAttribute("aria-label", `${label}: ${points.map((p) => `${shortDay(p.day)} ${format(p.value)}`).join(", ")}`);
	yAxis(f, [0, max / 2, max], 0, max, format);

	const band = f.plotW / points.length;
	const barW = Math.min(24, band * 0.62);
	const every = Math.ceil(points.length / Math.max(1, Math.floor(f.plotW / 58)));
	points.forEach((p, i) => {
		const x = M.left + band * i + (band - barW) / 2;
		const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * f.plotH);
		const y = M.top + f.plotH - h;
		const r = Math.min(4, h, barW / 2);
		// 4px rounded data-end, square at the baseline.
		const d = `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`;
		const t = tip(p);
		const hit = el("svg:rect", {
			class: "bar-hit",
			x: M.left + band * i,
			y: M.top,
			width: band,
			height: f.plotH,
			tabindex: 0,
			"aria-label": `${t.label}: ${t.value}`,
			onpointermove: (e) => showTip(e.clientX, e.clientY, t.value, t.label),
			onpointerleave: hideTip,
			onfocus: (e) => {
				const b = e.target.getBoundingClientRect();
				showTip(b.left + b.width / 2, b.top + ((f.plotH - h) / f.plotH) * b.height, t.value, t.label);
			},
			onblur: hideTip,
		});
		f.svg.append(hit, el("svg:path", { class: "bar", d }));
		if (i % every === 0) f.svg.append(el("svg:text", { class: "tick", x: x + barW / 2, y: M.top + f.plotH + 18, "text-anchor": "middle" }, shortDay(p.day)));
	});
	// Label the extreme only, never every bar.
	const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
	const pi = points.indexOf(peak);
	f.svg.append(el("svg:text", { class: "value-label", x: M.left + band * pi + band / 2, y: M.top + f.plotH - (peak.value / max) * f.plotH - 6, "text-anchor": "middle" }, format(peak.value)));
	container.replaceChildren(f.svg);
}

// Single-series line chart with an area wash, a crosshair that snaps to the nearest
// day, and optional flagged points (status colour plus a text label, never colour alone).
function lineChart(container, points, { min, max, ticks, format, label, tip, flag, emptyText }) {
	if (!points.length) return empty(container, emptyText);
	const f = frame(container, 230);
	f.svg.setAttribute("aria-label", `${label}: ${points.map((p) => `${shortDay(p.day)} ${format(p.value)}`).join(", ")}`);
	yAxis(f, ticks, min, max, format);

	const step = points.length > 1 ? f.plotW / (points.length - 1) : 0;
	const xAt = (i) => M.left + (points.length > 1 ? step * i : f.plotW / 2);
	const yAt = (v) => M.top + f.plotH - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * f.plotH;
	const pts = points.map((p, i) => [xAt(i), yAt(p.value)]);
	const cross = el("svg:line", { class: "crosshair", y1: M.top, y2: M.top + f.plotH, visibility: "hidden" });
	f.svg.append(cross);
	if (pts.length > 1) {
		const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
		f.svg.append(el("svg:path", { class: "area", d: `${line}L${pts.at(-1)[0]},${yAt(min)}L${pts[0][0]},${yAt(min)}Z` }));
		f.svg.append(el("svg:path", { class: "line", d: line }));
	}
	const every = Math.ceil(points.length / Math.max(1, Math.floor(f.plotW / 58)));
	points.forEach((p, i) => {
		const [x, y] = pts[i];
		const flagged = flag?.(p);
		f.svg.append(el("svg:circle", { class: `point${flagged ? " regressed" : ""}`, cx: x, cy: y, r: 5 }));
		if (flagged) f.svg.append(el("svg:text", { class: "marker-label", x, y: y + 20, "text-anchor": "middle" }, flagged));
		if (i % every === 0 || i === points.length - 1) {
			f.svg.append(el("svg:text", { class: "tick", x, y: M.top + f.plotH + 18, "text-anchor": i === 0 && points.length > 1 ? "start" : i === points.length - 1 && points.length > 1 ? "end" : "middle" }, shortDay(p.day)));
		}
	});
	f.svg.append(
		el("svg:rect", {
			x: M.left - step / 2,
			y: M.top,
			width: f.plotW + step,
			height: f.plotH,
			fill: "transparent",
			onpointermove: (e) => {
				const box = f.svg.getBoundingClientRect();
				const sx = ((e.clientX - box.left) / box.width) * f.width;
				const i = Math.max(0, Math.min(points.length - 1, Math.round((sx - M.left) / (step || 1))));
				cross.setAttribute("x1", pts[i][0]);
				cross.setAttribute("x2", pts[i][0]);
				cross.setAttribute("visibility", "visible");
				const t = tip(points[i]);
				showTip(e.clientX, box.top + (pts[i][1] / f.height) * box.height, t.value, t.label);
			},
			onpointerleave: () => {
				cross.setAttribute("visibility", "hidden");
				hideTip();
			},
		}),
	);
	container.replaceChildren(f.svg);
}

// A tile's trend: a muted line, recessive next to the number it supports.
function sparkline(values) {
	const wrap = el("div", { class: "spark", "aria-hidden": "true" });
	if (values.length < 2) return wrap;
	const w = 160;
	const h = 24;
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const y = (v) => (hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4));
	const x = (i) => (i / (values.length - 1)) * w;
	const svg = el("svg:svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
	svg.append(el("svg:path", { class: "spark-line", d: values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(""), "vector-effect": "non-scaling-stroke" }));
	wrap.append(svg);
	return wrap;
}

function table(headers, rows) {
	return el(
		"table",
		{},
		el("thead", {}, el("tr", {}, headers.map(([h, num]) => el("th", { class: num ? "num" : null, scope: "col" }, h)))),
		el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map(([v, num]) => el("td", { class: num ? "num" : null }, v))))),
	);
}

// A number with an inline bar showing its share of the column's maximum.
function magnitude(text, fraction) {
	const fill = el("span", { class: "fill" });
	fill.style.width = `${Math.max(2, Math.round(fraction * 100))}%`;
	return el("span", { class: "magnitude" }, text, el("span", { class: "track", "aria-hidden": "true" }, fill));
}

// ---- Rendering --------------------------------------------------------------------------

function tile(label, value, note, { flag, trend } = {}) {
	return el(
		"div",
		{ class: "tile" },
		el("div", { class: "label" }, label),
		el("div", { class: "value" }, value),
		note ? el("div", { class: "note" }, note) : null,
		flag ? el("div", { class: `flag ${flag.kind}` }, el("span", { class: "dot", "aria-hidden": "true" }), flag.text) : null,
		trend ? sparkline(trend) : null,
	);
}

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
