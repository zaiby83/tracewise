// API keys: list, create (the secret is shown once) and revoke.

import { el } from "../../shared/dom.js";
import { table } from "../../shared/charts.js";
import { cardHead, confirmDialog, errorLine, field, fmtDate, pageHead, run, secretDialog, showError } from "../ui.js";

const SCOPES = { write: "Read and write", read: "Read only" };

export async function render(root, ctx) {
	const base = `/v1/orgs/${ctx.org.org_id}/keys`;
	const list = el("div", { class: "table-wrap" });
	const listError = errorLine();

	async function load() {
		const { keys } = await ctx.api.get(base);
		if (!keys.length) return list.replaceChildren(el("p", { class: "empty" }, "No keys yet. Create one to send traces."));
		const revokeButton = (k) => el("button", { class: "button danger-text", type: "button", onclick: () => revoke(k) }, "Revoke");
		const t = table(
			[["Name"], ["Key"], ["Scope"], ["Created"], ["Last used"], ["Actions", 1]],
			keys.map((k) => [[k.name], [el("span", { class: "mono" }, `${k.prefix}…`)], [SCOPES[k.scope] ?? k.scope], [fmtDate(k.created_at)], [k.last_used_at ? fmtDate(k.last_used_at) : "Never"], [revokeButton(k), 1]]),
		);
		list.replaceChildren(t);
	}

	async function revoke(k) {
		const ok = await confirmDialog({ title: `Revoke "${k.name}"?`, body: "Anything still using this key stops working immediately. This can't be undone.", confirm: "Revoke key" });
		if (!ok) return;
		showError(listError, "");
		try {
			await ctx.api.del(`${base}/${encodeURIComponent(k.key_id)}`);
			await load();
		} catch (err) {
			// A 404 means the key is already gone, so it is the list that is stale.
			if (err.status === 404) await load().catch(() => {});
			showError(listError, err.message);
		}
	}

	const name = el("input", { name: "name", maxlength: 100, required: true, autocomplete: "off", placeholder: "e.g. production" });
	const scope = el("select", { name: "scope" }, el("option", { value: "write" }, SCOPES.write), el("option", { value: "read" }, SCOPES.read));
	const createError = errorLine();
	const submit = el("button", { class: "button primary", type: "submit" }, "Create key");
	const form = el(
		"form",
		{
			class: "form inline",
			onsubmit: async (e) => {
				e.preventDefault();
				const value = name.value.trim();
				if (!value) return showError(createError, "Give the key a name.");
				await run(submit, createError, async () => {
					const { key } = await ctx.api.post(base, { name: value, scope: scope.value });
					name.value = "";
					// The secret goes on screen first; the list refreshes behind the dialog.
					const shown = secretDialog({ title: "Your new API key", intro: `Use this key for "${key.name}".`, secret: key.secret, label: "API key" });
					await load().catch(() => {});
					await shown;
				});
			},
		},
		field("Name", name),
		field("Scope", scope, "Write keys send traces and read data. Read keys can only read."),
		el("div", { class: "actions" }, submit),
	);

	root.replaceChildren(
		pageHead("API keys", "Keys authenticate your app to Tracewise. Send one as a Bearer token."),
		el("section", { class: "card" }, cardHead("Create a key"), form, createError),
		el("section", { class: "card" }, cardHead("Your keys"), listError, list),
	);
	await load();
}
