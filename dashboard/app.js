// Tracewise dashboard. Plain DOM and SVG, no dependencies.
// Every value from the API is inserted with textContent: trace content is
// customer-controlled and must never be interpreted as HTML.

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const KEY_STORAGE = "tracewise_key";

let config = { demoKey: "" };
let days = 7;
let data = null;

// ---- Small helpers ---------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
	const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === "class") node.setAttribute("class", v);
		else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return node;
}

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

// ---- API --------------------------------------------------------------------------

function apiKey() {
	try {
		return sessionStorage.getItem(KEY_STORAGE) || config.demoKey;
	} catch {
		return config.demoKey;
	}
}
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

// ---- Tooltip ------------------------------------------------------------------------

const tooltip = () => $("tooltip");
function showTip(x, y, value, label) {
	const t = tooltip();
	t.replaceChildren(el("div", { class: "tv" }, value), el("div", { class: "tl" }, label));
	t.hidden = false;
	const { width, height } = t.getBoundingClientRect();
	t.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2))}px`;
	t.style.top = `${Math.max(8, y - height - 12)}px`;
}
const hideTip = () => (tooltip().hidden = true);

// ---- Charts -------------------------------------------------------------------------

const M = { top: 12, right: 12, bottom: 28, left: 44 };

function frame(container, height) {
	const width = Math.max(280, container.clientWidth || 600);
	const svg = el("svg:svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
	return { svg, width, height, plotW: width - M.left - M.right, plotH: height - M.top - M.bottom };
}

function yAxis(svg, f, ticks, max, min, format) {
	for (const t of ticks) {
		const y = M.top + f.plotH - ((t - min) / (max - min)) * f.plotH;
		svg.append(el("svg:line", { class: t === min ? "baseline" : "gridline", x1: M.left, x2: M.left + f.plotW, y1: y, y2: y }));
		svg.append(el("svg:text", { class: "tick", x: M.left - 8, y: y + 4, "text-anchor": "end" }, format(t)));
	}
}

// Single-series column chart: one colour, no legend (the card title names the series).
function columnChart(container, points, { format, label, describe }) {
	container.replaceChildren();
	if (!points.length) return container.append(el("p", { class: "empty" }, "No data in this range yet."));
	const f = frame(container, 220);
	const max = niceMax(Math.max(...points.map((p) => p.value)));
	f.svg.setAttribute("aria-label", `${label}: ${points.map((p) => `${p.label} ${format(p.value)}`).join(", ")}`);
	yAxis(f.svg, f, [0, max / 2, max], max, 0, format);

	const band = f.plotW / points.length;
	const barW = Math.min(24, band * 0.6);
	const labelEvery = Math.ceil(points.length / Math.max(1, Math.floor(f.plotW / 56)));
	points.forEach((p, i) => {
		const x = M.left + band * i + (band - barW) / 2;
		const h = Math.max(p.value > 0 ? 2 : 0, (p.value / max) * f.plotH);
		const y = M.top + f.plotH - h;
		const r = Math.min(4, h, barW / 2);
		// 4px rounded data-end, square at the baseline.
		const d = `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`;
		const tip = describe(p);
		const hit = el("svg:rect", {
			class: "bar-hit",
			x: M.left + band * i,
			y: M.top,
			width: band,
			height: f.plotH,
			tabindex: 0,
			"aria-label": `${tip.label}: ${tip.value}`,
			onpointermove: (e) => showTip(e.clientX, e.clientY, tip.value, tip.label),
			onpointerleave: hideTip,
			onfocus: (e) => {
				const b = e.target.getBoundingClientRect();
				showTip(b.left + b.width / 2, b.top + (b.height * (f.plotH - h)) / f.plotH, tip.value, tip.label);
			},
			onblur: hideTip,
		});
		f.svg.append(hit, el("svg:path", { class: "bar", d }));
		if (i % labelEvery === 0) {
			f.svg.append(el("svg:text", { class: "tick", x: x + barW / 2, y: M.top + f.plotH + 18, "text-anchor": "middle" }, shortDay(p.label)));
		}
	});
	// Label the extreme only, never every bar.
	const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
	const pi = points.indexOf(peak);
	f.svg.append(
		el("svg:text", { class: "value-label", x: M.left + band * pi + band / 2, y: M.top + f.plotH - (peak.value / max) * f.plotH - 6, "text-anchor": "middle" }, format(peak.value)),
	);
	container.append(f.svg);
}

// Quality line chart, fixed 1-5 scale. Regressed days are marked with the critical
// status colour plus a text label, never colour alone.
function qualityChart(container, runs) {
	container.replaceChildren();
	if (!runs.length) return container.append(el("p", { class: "empty" }, "No evaluation runs yet. The judge runs nightly at 06:00 UTC."));
	const f = frame(container, 240);
	const [min, max] = [1, 5];
	f.svg.setAttribute("aria-label", `Answer quality: ${runs.map((r) => `${r.day} ${r.meanOverall?.toFixed(2)}`).join(", ")}`);
	yAxis(f.svg, f, [1, 2, 3, 4, 5], max, min, (t) => String(t));

	const step = runs.length > 1 ? f.plotW / (runs.length - 1) : 0;
	const xAt = (i) => M.left + (runs.length > 1 ? step * i : f.plotW / 2);
	const yAt = (v) => M.top + f.plotH - ((v - min) / (max - min)) * f.plotH;
	const pts = runs.map((r, i) => [xAt(i), yAt(r.meanOverall ?? min)]);
	if (pts.length > 1) {
		const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("");
		f.svg.append(el("svg:path", { class: "area", d: `${line}L${pts.at(-1)[0]},${yAt(min)}L${pts[0][0]},${yAt(min)}Z` }));
		f.svg.append(el("svg:path", { class: "line", d: line }));
	}
	const labelEvery = Math.ceil(runs.length / Math.max(1, Math.floor(f.plotW / 56)));
	runs.forEach((r, i) => {
		const [x, y] = pts[i];
		f.svg.append(el("svg:circle", { class: `point${r.regressed ? " regressed" : ""}`, cx: x, cy: y, r: 5 }));
		if (r.regressed) f.svg.append(el("svg:text", { class: "marker-label", x, y: y + 20, "text-anchor": "middle" }, "▲ Regression"));
		if (i % labelEvery === 0 || i === runs.length - 1) {
			f.svg.append(el("svg:text", { class: "tick", x, y: M.top + f.plotH + 18, "text-anchor": "middle" }, shortDay(r.day)));
		}
	});
	// Crosshair layer: the pointer finds the nearest day, it doesn't have to hit the dot.
	const cross = el("svg:line", { class: "crosshair", y1: M.top, y2: M.top + f.plotH, visibility: "hidden" });
	const hit = el("svg:rect", {
		x: M.left - step / 2,
		y: M.top,
		width: f.plotW + step,
		height: f.plotH,
		fill: "transparent",
		onpointermove: (e) => {
			const box = f.svg.getBoundingClientRect();
			const sx = ((e.clientX - box.left) / box.width) * f.width;
			const i = Math.max(0, Math.min(runs.length - 1, Math.round((sx - M.left) / (step || 1))));
			const r = runs[i];
			cross.setAttribute("x1", pts[i][0]);
			cross.setAttribute("x2", pts[i][0]);
			cross.setAttribute("visibility", "visible");
			showTip(e.clientX, box.top + (pts[i][1] / f.height) * box.height, `${r.meanOverall?.toFixed(2)} / 5`, `${shortDay(r.day)} · ${r.scored} graded${r.safetyFailures ? ` · ${r.safetyFailures} safety failures` : ""}${r.regressed ? " · regression" : ""}`);
		},
		onpointerleave: () => {
			cross.setAttribute("visibility", "hidden");
			hideTip();
		},
	});
	f.svg.prepend(cross);
	f.svg.append(hit);
	container.append(f.svg);
}

function table(headers, rows) {
	return el(
		"table",
		{},
		el("thead", {}, el("tr", {}, headers.map(([h, num]) => el("th", { class: num ? "num" : null, scope: "col" }, h)))),
		el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map(([v, num]) => el("td", { class: num ? "num" : null }, v))))),
	);
}

// ---- Rendering --------------------------------------------------------------------------

function tile(label, value, note, flag) {
	return el(
		"div",
		{ class: "tile" },
		el("div", { class: "label" }, label),
		el("div", { class: "value" }, value),
		note ? el("div", { class: "note" }, note) : null,
		flag ? el("div", { class: `flag ${flag.kind}` }, el("span", { class: "dot", "aria-hidden": "true" }), flag.text) : null,
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
		tile("Calls", fmtCalls(calls), `last ${days} days`),
		tile("Model spend", fmtCost(cost), calls ? `${fmtCost(cost / calls)} per call` : null),
		tile("Error rate", calls ? fmtPct(errors / calls) : "–", `${int.format(errors)} failed calls`),
		tile("Attacks blocked", int.format(blocked), "by Prompt Shield"),
		latest
			? tile("Answer quality", `${latest.meanOverall.toFixed(2)} / 5`, `judged ${shortDay(latest.day)}`, latest.regressed ? { kind: "bad", text: "Regression vs last week" } : { kind: "ok", text: "Within normal range" })
			: tile("Answer quality", "–", "no evaluation yet"),
	);

	columnChart($("chart-calls"), byDay.map((d) => ({ label: d.day, value: d.calls })), {
		label: "Calls per day",
		format: fmtCalls,
		describe: (p) => ({ value: `${int.format(p.value)} calls`, label: shortDay(p.label) }),
	});
	columnChart($("chart-cost"), byDay.map((d) => ({ label: d.day, value: d.cost_usd })), {
		label: "Model spend per day",
		format: fmtCost,
		describe: (p) => ({ value: fmtCost(p.value), label: shortDay(p.label) }),
	});
	qualityChart($("chart-quality"), runs);

	$("table-calls").replaceChildren(table([["Day"], ["Calls", 1], ["p95 latency", 1], ["Errors", 1], ["Blocked", 1]], byDay.map((d) => [[d.day], [int.format(d.calls), 1], [fmtMs(d.p95_ms), 1], [d.errors, 1], [d.blocked, 1]])));
	$("table-cost").replaceChildren(table([["Day"], ["Spend", 1]], byDay.map((d) => [[d.day], [fmtCost(d.cost_usd), 1]])));
	$("table-quality").replaceChildren(
		table([["Day"], ["Mean score", 1], ["Graded", 1], ["Safety failures", 1], ["Regression"]], runs.map((r) => [[r.day], [r.meanOverall.toFixed(2), 1], [r.scored, 1], [r.safetyFailures, 1], [r.regressed ? "Yes" : "No"]])),
	);

	$("routes").replaceChildren(
		summary.byRoute.length
			? table(
					[["Route"], ["Model"], ["Calls", 1], ["p50", 1], ["p95", 1], ["Spend", 1], ["Errors", 1], ["Blocked", 1]],
					summary.byRoute.map((r) => [[r.route], [r.model], [int.format(r.calls), 1], [fmtMs(r.p50_ms), 1], [fmtMs(r.p95_ms), 1], [fmtCost(r.cost_usd), 1], [fmtPct(r.error_rate), 1], [r.blocked, 1]]),
				)
			: el("p", { class: "empty" }, "No traffic in this range yet."),
	);

	// Only genuinely poor answers (below 3/5) from the latest evaluated day.
	const LOW = 3;
	const low = latest ? latest.worst.filter((w) => w.overall < LOW) : [];
	$("worst-day").textContent = latest ? `below ${LOW}/5, from the evaluation of ${shortDay(latest.day)}` : "";
	$("worst").replaceChildren(
		...(!latest
			? [el("li", {}, "No evaluations yet.")]
			: low.length
				? low.map((w) => el("li", {}, el("span", { class: "score" }, `${w.overall.toFixed(1)} / 5`), el("span", { class: "route" }, w.route), el("span", { class: "reason" }, w.reason)))
				: [el("li", {}, `No answers scored below ${LOW}/5 in the latest evaluation.`)]),
	);

	$("traces-day").textContent = traces.day ? `on ${shortDay(traces.day)}` : "";
	const rows = [];
	for (const t of traces.traces) {
		const status = t.security?.verdict === "blocked" ? ["bad", "Blocked"] : t.status === "error" ? ["warn", "Error"] : ["ok", "OK"];
		const detail = el(
			"tr",
			{ class: "detail", hidden: true },
			el("td", { colspan: 6 }, el("div", { class: "io" }, el("div", {}, el("div", { class: "k" }, "Input"), el("pre", {}, t.input)), el("div", {}, el("div", { class: "k" }, "Output"), el("pre", {}, t.output || "(none)")))),
		);
		const toggle = () => {
			detail.hidden = !detail.hidden;
			row.setAttribute("aria-expanded", String(!detail.hidden));
		};
		const row = el(
			"tr",
			{ class: "trace", tabindex: 0, "aria-expanded": "false", onclick: toggle, onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()) },
			el("td", {}, new Date(t.ts).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })),
			el("td", {}, t.route ?? "–"),
			el("td", {}, t.model),
			el("td", { class: "num" }, fmtMs(t.latency_ms)),
			el("td", { class: "num" }, t.cost_usd != null ? fmtCost(t.cost_usd) : "–"),
			el("td", {}, el("span", { class: `pill ${status[0]}` }, el("span", { class: "dot", "aria-hidden": "true" }), status[1])),
		);
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

// ---- Loading ------------------------------------------------------------------------------

async function load() {
	document.body.classList.add("loading");
	$("status").textContent = "Loading…";
	try {
		const [me, summary, evals, traces] = await Promise.all([api("/v1/me"), api(`/v1/analytics/summary?days=${days}`), api("/v1/evals?limit=30"), recentTraces()]);
		data = { summary, evals, traces };
		$("tenant-name").textContent = me.name;
		const badge = $("mode-badge");
		badge.hidden = false;
		badge.textContent = usingDemo() ? "Demo data · read-only" : me.scope === "read" ? "Read-only key" : "Your key";
		$("key-button").textContent = usingDemo() ? "Use your own key" : "Change key";
		render();
		$("status").textContent = summary.query?.reusedCachedResult ? "Analytics served from Athena's result cache" : `Analytics query: ${summary.query?.ms ?? "?"} ms`;
	} catch (err) {
		$("status").textContent = err.status === 401 ? "That key isn't valid." : `Couldn't load data: ${err.message}`;
		if (err.status === 401 && !usingDemo()) {
			try {
				sessionStorage.removeItem(KEY_STORAGE);
			} catch {}
		}
	} finally {
		document.body.classList.remove("loading");
	}
}

function wire() {
	for (const b of document.querySelectorAll(".range")) {
		b.addEventListener("click", () => {
			days = Number(b.dataset.days);
			for (const o of document.querySelectorAll(".range")) o.setAttribute("aria-pressed", String(o === b));
			load();
		});
	}
	const dialog = $("key-dialog");
	$("key-button").addEventListener("click", () => {
		$("key-error").hidden = true;
		$("key-input").value = "";
		dialog.showModal();
	});
	$("key-cancel").addEventListener("click", () => dialog.close());
	$("key-demo").addEventListener("click", () => {
		try {
			sessionStorage.removeItem(KEY_STORAGE);
		} catch {}
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
		try {
			sessionStorage.setItem(KEY_STORAGE, key);
		} catch {}
		load();
	});
	let resize;
	window.addEventListener("resize", () => {
		clearTimeout(resize);
		resize = setTimeout(render, 150);
	});
}

async function main() {
	try {
		config = await (await fetch("config.json")).json();
	} catch {
		$("status").textContent = "Missing config.json.";
	}
	wire();
	load();
}
main();
