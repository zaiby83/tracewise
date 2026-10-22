// Charts, tables and tiles drawn with plain DOM and SVG.

import { el, empty, $ } from "./dom.js";
import { niceMax, shortDay } from "./format.js";

// ---- Tooltip ----------------------------------------------------------------------------

export function showTip(x, y, value, label) {
	const t = $("tooltip");
	t.replaceChildren(el("div", { class: "tv" }, value), el("div", { class: "tl" }, label));
	t.hidden = false;
	const { width, height } = t.getBoundingClientRect();
	t.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2))}px`;
	t.style.top = `${Math.max(8, y - height - 12)}px`;
}
export const hideTip = () => ($("tooltip").hidden = true);

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

// Single-series column chart: one colour, no legend (the card title names the series).
export function columnChart(container, points, { format, label, tip }) {
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
export function lineChart(container, points, { min, max, ticks, format, label, tip, flag, emptyText }) {
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
export function sparkline(values) {
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

export function table(headers, rows) {
	return el(
		"table",
		{},
		el("thead", {}, el("tr", {}, headers.map(([h, num]) => el("th", { class: num ? "num" : null, scope: "col" }, h)))),
		el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map(([v, num]) => el("td", { class: num ? "num" : null }, v))))),
	);
}

// A number with an inline bar showing its share of the column's maximum.
export function magnitude(text, fraction) {
	const fill = el("span", { class: "fill" });
	fill.style.width = `${Math.max(2, Math.round(fraction * 100))}%`;
	return el("span", { class: "magnitude" }, text, el("span", { class: "track", "aria-hidden": "true" }, fill));
}

// ---- Tiles ------------------------------------------------------------------------------

export function tile(label, value, note, { flag, trend } = {}) {
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
