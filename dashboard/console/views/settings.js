// Organization settings: name, the judge rubric, evaluations on or off, and deleting the org.
// Members see the values and none of the controls (the API refuses their changes anyway).

import { el, storage } from "../../shared/dom.js";
import { ORG_KEY, cardHead, errorLine, field, pageHead, run, showError } from "../ui.js";

export async function render(root, ctx) {
	const base = `/v1/orgs/${ctx.org.org_id}`;
	const org = await ctx.api.get(base);
	const owner = org.role === "owner";

	if (!owner) {
		root.replaceChildren(
			pageHead("Settings", "Only owners can change these."),
			el(
				"section",
				{ class: "card" },
				cardHead("Organization"),
				el("dl", { class: "facts" }, el("dt", {}, "Name"), el("dd", {}, org.name), el("dt", {}, "Answer scoring"), el("dd", {}, org.evals_enabled ? "On" : "Off"), el("dt", {}, "Scoring rubric"), el("dd", {}, org.rubric ? "Custom" : "Default")),
			),
		);
		return;
	}

	const name = el("input", { name: "name", maxlength: 100, required: true, value: org.name, autocomplete: "off" });
	const rubric = el("textarea", { name: "rubric", maxlength: 4000, rows: 10, placeholder: org.default_rubric, spellcheck: "false" }, org.rubric ?? "");
	const evals = el("input", { type: "checkbox", name: "evals_enabled", checked: org.evals_enabled });
	const status = el("p", { class: "hint", role: "status" });
	const error = errorLine();
	const save = el("button", { class: "button primary", type: "submit" }, "Save changes");
	const reset = el("button", { class: "button", type: "button" }, "Reset to default");

	// Saves the given fields, then refreshes the header so a rename shows in the switcher.
	async function patch(body, done) {
		status.textContent = "";
		return run(save, error, async () => {
			await ctx.api.patch(base, body);
			await ctx.refreshOrgs();
			status.textContent = done;
		});
	}

	reset.addEventListener("click", async () => {
		if (await patch({ rubric: null }, "Rubric reset to the default.")) rubric.value = "";
	});

	const form = el(
		"form",
		{
			class: "form",
			onsubmit: (e) => {
				e.preventDefault();
				const value = name.value.trim();
				if (!value) return showError(error, "The name can't be empty.");
				// An empty rubric means the default, which the API stores as null.
				patch({ name: value, rubric: rubric.value.trim() ? rubric.value : null, evals_enabled: evals.checked }, "Saved.");
			},
		},
		field("Organization name", name),
		field("Scoring rubric", rubric, "How the nightly judge scores answers. Leave it empty to use the default shown here."),
		el("div", { class: "actions start" }, reset),
		el("label", { class: "check" }, evals, "Score answers nightly"),
		error,
		status,
		el("div", { class: "actions start" }, save),
	);

	root.replaceChildren(pageHead("Settings", `Manage ${org.name}.`), el("section", { class: "card" }, cardHead("Organization"), form), dangerZone());

	function dangerZone() {
		const confirm = el("input", { name: "confirm", autocomplete: "off", spellcheck: "false" });
		const remove = el("button", { class: "button danger", type: "button", disabled: true }, "Delete organization");
		const failed = errorLine();
		confirm.addEventListener("input", () => (remove.disabled = confirm.value !== org.name));
		remove.addEventListener("click", () =>
			run(remove, failed, async () => {
				await ctx.api.del(base, { confirm_name: confirm.value });
				// It is on its way out: forget it, reload the list and go to whatever is next.
				storage.set(sessionStorage, ORG_KEY, null);
				await ctx.refreshOrgs();
				ctx.navigate("#/");
			}),
		);
		return el(
			"section",
			{ class: "card danger-zone" },
			cardHead("Danger zone"),
			el("p", {}, "Deleting the organization removes its keys, traces and members for good. This can't be undone."),
			field(`Type "${org.name}" to confirm`, confirm),
			failed,
			el("div", { class: "actions start" }, remove),
		);
	}
}
