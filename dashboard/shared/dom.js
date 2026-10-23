// DOM helpers shared by the demo dashboard and the console. Nothing here touches
// the document until a function is called, so the module can be imported anywhere.
// Every value is inserted as text: trace content is customer-controlled and must
// never be interpreted as HTML.

const SVG = "http://www.w3.org/2000/svg";

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
	const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	return node;
}

export const storage = {
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

export const empty = (container, text) => container.replaceChildren(el("p", { class: "empty" }, text));
