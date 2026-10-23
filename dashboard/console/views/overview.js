// The landing screen: where to send traces, and a command that does it.

import { el } from "../../shared/dom.js";
import { cardHead, copyButton, pageHead, takeKey } from "../ui.js";

const PLACEHOLDER = "<your key>";

// The README's ingest example with the endpoint and key filled in and a fresh event.
export function curlQuickstart(endpoint, key) {
	const event = { event_id: crypto.randomUUID(), ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), model: "demo", input: "hi", output: "hello", latency_ms: 120 };
	return `curl -X POST "${endpoint}/v1/traces" -H "authorization: Bearer ${key}" -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ events: [event] })}'`;
}

const TABS = [
	["curl", "curl", true],
	["ts", "TypeScript SDK", false],
	["py", "Python SDK", false],
];

export async function render(root, ctx) {
	const key = takeKey(ctx.org.org_id);
	const endpoint = el("code", { class: "code-line" }, location.origin);
	const command = el("pre", { class: "code", tabindex: 0 }, curlQuickstart(location.origin, key ?? PLACEHOLDER));
	const panels = new Map([
		["curl", el("div", {}, key ? el("p", { class: "callout" }, "This command contains your new key. It won't be shown again after you leave this page.") : el("p", { class: "hint" }, "Replace <your key> with a key from API keys."), command, el("div", { class: "actions" }, copyButton(command, "Copy command")))],
		["ts", el("p", { class: "empty" }, "The TypeScript SDK is coming soon.")],
		["py", el("p", { class: "empty" }, "The Python SDK is coming soon.")],
	]);
	const buttons = new Map();
	const select = (id) => {
		for (const [other, panel] of panels) panel.hidden = other !== id;
		for (const [other, button] of buttons) button.setAttribute("aria-pressed", String(other === id));
	};
	for (const [id, label, ready] of TABS) {
		buttons.set(id, el("button", { class: "range", type: "button", onclick: () => select(id) }, label, ready ? null : el("span", { class: "soon" }, "coming soon")));
	}
	select("curl");

	root.replaceChildren(
		pageHead(ctx.org.name, "Send your first trace, then watch it appear under Traces."),
		el("section", { class: "card" }, cardHead("Endpoint", "Send traces here"), el("div", { class: "copy-row" }, endpoint, copyButton(endpoint))),
		el("section", { class: "card" }, cardHead("Quickstart"), el("div", { class: "segmented" }, ...buttons.values()), el("div", { class: "panels" }, ...panels.values())),
	);
}
