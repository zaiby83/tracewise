// Small UI pieces the console views share: page headings, form fields, copy buttons and the
// dialogs for one-time secrets and confirmations. Plain DOM; every value goes in as text.

import { el } from "../shared/dom.js";

// The shell restores the current org from this session key, so a view that creates or joins
// an org saves it here before asking the shell to reload the list.
export const ORG_KEY = "tw_org";

// A key just created by orgs-new, kept in memory only so the overview can fill the quickstart
// with it once. It is never written to storage.
let fresh = null;
export const rememberKey = (orgId, secret) => {
	fresh = { orgId, secret };
};
export function takeKey(orgId) {
	const key = fresh?.orgId === orgId ? fresh.secret : null;
	fresh = null;
	return key;
}

export const pageHead = (title, sub) => el("header", { class: "page-head" }, el("h1", {}, title), sub ? el("p", { class: "lede" }, sub) : null);

export const cardHead = (title, sub) => el("header", { class: "card-head" }, el("h2", {}, title), sub ? el("p", { class: "sub" }, sub) : null);

let ids = 0;
// A labelled control. The label wraps nothing: it is tied to the control by id, so the
// hint can sit between them without becoming part of the label.
export function field(label, control, hint) {
	const id = control.id || `f${++ids}`;
	control.id = id;
	return el("div", { class: "field" }, el("label", { for: id }, label), control, hint ? el("p", { class: "hint" }, hint) : null);
}

export const errorLine = () => el("p", { class: "error", role: "alert", hidden: true });

export function showError(line, message) {
	line.textContent = message ?? "";
	line.hidden = !message;
}

// Runs an action behind a button: disabled while it works, and any failure lands in the
// error line instead of escaping. Returns false when the action failed.
export async function run(button, line, action) {
	showError(line, "");
	button.disabled = true;
	try {
		await action();
		return true;
	} catch (err) {
		showError(line, err.message);
		return false;
	} finally {
		button.disabled = false;
	}
}

// A copy button for `target`, an input or any element showing the text. Where the clipboard
// is unavailable (an insecure origin, a denied permission) it selects the text instead.
export function copyButton(target, label = "Copy") {
	const button = el("button", { class: "button", type: "button" }, label);
	const text = () => ("value" in target ? target.value : target.textContent);
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(text());
			button.textContent = "Copied";
		} catch {
			if (target.select) target.select();
			else {
				const range = document.createRange();
				range.selectNodeContents(target);
				const sel = getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
			}
			button.textContent = "Press Ctrl+C to copy";
		}
		setTimeout(() => (button.textContent = label), 2500);
	});
	return button;
}

// Opens a modal built from `children`, removes it when closed, and resolves with the value
// passed to close(). Escape is a "dismiss" for ordinary dialogs; a secret dialog has none.
function modal(title, children, { dismissible }) {
	return new Promise((resolve) => {
		const heading = el("h2", { id: `d${++ids}` }, title);
		const dialog = el("dialog", { "aria-labelledby": heading.id }, heading, ...children(close));
		function close(value) {
			dialog.close();
			dialog.remove();
			resolve(value);
		}
		dialog.addEventListener("cancel", (e) => {
			e.preventDefault();
			if (dismissible) close(false);
		});
		document.body.append(dialog);
		dialog.showModal();
	});
}

// Shows a secret exactly once. Resolves when the person says they have saved it.
export function secretDialog({ title, intro, secret, label, note = "This is the only time it is shown. Store it somewhere safe.", done = "I've saved it" }) {
	return modal(
		title,
		(close) => {
			const input = el("input", { readonly: true, value: secret, "aria-label": label, spellcheck: "false", autocomplete: "off" });
			queueMicrotask(() => input.select());
			return [
				el("p", {}, intro),
				el("p", { class: "callout" }, note),
				input,
				el("div", { class: "actions" }, copyButton(input), el("button", { class: "button primary", type: "button", onclick: () => close(true) }, done)),
			];
		},
		{ dismissible: false },
	);
}

// Resolves true when confirmed, false when cancelled.
export function confirmDialog({ title, body, confirm }) {
	return modal(
		title,
		(close) => [
			el("p", {}, body),
			el("div", { class: "actions" }, el("button", { class: "button", type: "button", onclick: () => close(false) }, "Cancel"), el("button", { class: "button danger", type: "button", onclick: () => close(true) }, confirm)),
		],
		{ dismissible: true },
	);
}

export const fmtDate = (value) => (value ? new Date(value).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "–");
