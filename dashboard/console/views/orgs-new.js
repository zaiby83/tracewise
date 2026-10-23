// Create an organization. The first API key comes back with it, and this is the one time
// its secret is shown.

import { el, storage } from "../../shared/dom.js";
import { ORG_KEY, errorLine, field, pageHead, rememberKey, run, secretDialog, showError } from "../ui.js";

export async function render(root, ctx) {
	const name = el("input", { name: "name", maxlength: 100, required: true, autocomplete: "off", spellcheck: "false" });
	const error = errorLine();
	const submit = el("button", { class: "button primary", type: "submit" }, "Create organization");
	const first = !ctx.org;

	const form = el(
		"form",
		{
			class: "form",
			onsubmit: async (e) => {
				e.preventDefault();
				const value = name.value.trim();
				if (!value) return showError(error, "Give the organization a name.");
				await run(submit, error, async () => {
					const { org, key } = await ctx.api.post("/v1/orgs", { name: value });
					// Switch to it: the shell picks the saved org when it reloads the list.
					storage.set(sessionStorage, ORG_KEY, org.org_id);
					rememberKey(org.org_id, key.secret);
					// Reload in the background; the secret goes on screen first because it can't be fetched again.
					const refreshed = ctx.refreshOrgs();
					refreshed.catch(() => {});
					await secretDialog({ title: "Your first API key", intro: `Use this key to send traces from ${org.name}.`, secret: key.secret, label: "API key" });
					await refreshed;
					ctx.navigate("#/");
				});
			},
		},
		field("Organization name", name, "Your company or project. You can rename it later."),
		error,
		el("div", { class: "actions" }, submit),
	);

	root.replaceChildren(el("section", { class: "card narrow" }, pageHead(first ? "Create your organization" : "New organization", "An organization holds your API keys, traces and team."), form));
	name.focus();
}
