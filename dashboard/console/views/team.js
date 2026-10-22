// Team: members and their roles, pending invites, and creating an invite link. Role changes,
// removals and invites are owner-only (the API enforces it; members just don't see the controls).

import { el } from "../../shared/dom.js";
import { table } from "../../shared/charts.js";
import { cardHead, confirmDialog, errorLine, field, fmtDate, pageHead, run, secretDialog, showError } from "../ui.js";

const ROLES = { owner: "Owner", member: "Member" };
const roleSelect = (value, attrs = {}) => el("select", attrs, ...Object.entries(ROLES).map(([v, label]) => el("option", { value: v, selected: v === value }, label)));
// Invite expiry is epoch seconds.
const expiry = (seconds) => fmtDate(seconds * 1000);

export async function render(root, ctx) {
	const owner = ctx.org.role === "owner";
	const base = `/v1/orgs/${ctx.org.org_id}`;
	const members = el("div", { class: "table-wrap" });
	const invites = el("div", { class: "table-wrap" });
	const memberError = errorLine();

	// Runs a change, then reloads so the lists (and any select that didn't take) show the truth.
	async function change(action) {
		showError(memberError, "");
		try {
			await action();
		} catch (err) {
			showError(memberError, err.message);
		}
		await load().catch(() => {});
	}

	async function leave(m) {
		const self = m.sub === ctx.me.sub;
		const ok = await confirmDialog({
			title: self ? `Leave ${ctx.org.name}?` : `Remove ${m.email}?`,
			body: self ? "You'll lose access to this organization until someone invites you again." : "They'll lose access to this organization immediately.",
			confirm: self ? "Leave" : "Remove",
		});
		if (!ok) return;
		const url = `${base}/members/${encodeURIComponent(m.sub)}`;
		if (!self) return change(() => ctx.api.del(url));
		// Leaving ends access to this org, so there is nothing here to reload: go to whatever is next.
		showError(memberError, "");
		try {
			await ctx.api.del(url);
			await ctx.refreshOrgs();
			ctx.navigate("#/");
		} catch (err) {
			showError(memberError, err.message);
		}
	}

	const memberRow = (m) => {
		const self = m.sub === ctx.me.sub;
		const role = owner
			? roleSelect(m.role, { "aria-label": `Role of ${m.email}`, onchange: (e) => change(() => ctx.api.patch(`${base}/members/${encodeURIComponent(m.sub)}`, { role: e.target.value })) })
			: ROLES[m.role];
		const action = self || owner ? el("button", { class: "button danger-text", type: "button", onclick: () => leave(m) }, self ? "Leave" : "Remove") : "";
		return [[self ? `${m.email} (you)` : m.email], [role], [fmtDate(m.joined_at)], [action, 1]];
	};

	async function load() {
		const [{ members: ms }, pending] = await Promise.all([ctx.api.get(`${base}/members`), owner ? ctx.api.get(`${base}/invites`) : { invites: [] }]);
		members.replaceChildren(table([["Member"], ["Role"], ["Joined"], ["Actions", 1]], ms.map(memberRow)));
		const revoke = (i) =>
			el("button", { class: "button danger-text", type: "button", onclick: () => change(() => ctx.api.del(`${base}/invites/${encodeURIComponent(i.invite_id)}`)) }, "Revoke");
		invites.replaceChildren(
			pending.invites.length
				? table([["Email"], ["Role"], ["Expires"], ["Actions", 1]], pending.invites.map((i) => [[i.email], [ROLES[i.role] ?? i.role], [expiry(i.expires_at)], [revoke(i), 1]]))
				: el("p", { class: "empty" }, "No pending invites."),
		);
	}

	const email = el("input", { type: "email", name: "email", required: true, autocomplete: "off", maxlength: 254, placeholder: "teammate@example.com" });
	const role = roleSelect("member", { name: "role" });
	const inviteError = errorLine();
	const send = el("button", { class: "button primary", type: "submit" }, "Create invite link");
	const inviteForm = el(
		"form",
		{
			class: "form inline",
			onsubmit: async (e) => {
				e.preventDefault();
				await run(send, inviteError, async () => {
					const address = email.value.trim();
					const created = await ctx.api.post(`${base}/invites`, { email: address, role: role.value });
					email.value = "";
					const shown = secretDialog({
						title: "Invite link",
						intro: `Send this link to ${address}. They sign in with that email address to join.`,
						secret: created.link,
						label: "Invite link",
						note: `The link works once and expires on ${expiry(created.expires_at)}. It is not shown again.`,
						done: "Done",
					});
					await load().catch(() => {});
					await shown;
				});
			},
		},
		field("Email", email, "Must match the email they sign up with."),
		field("Role", role),
		el("div", { class: "actions" }, send),
	);

	root.replaceChildren(
		pageHead("Team", `People in ${ctx.org.name}. Owners manage keys, members and settings.`),
		el("section", { class: "card" }, cardHead("Members"), memberError, members),
		...(owner ? [el("section", { class: "card" }, cardHead("Invite someone"), inviteForm, inviteError), el("section", { class: "card" }, cardHead("Pending invites"), invites)] : []),
	);
	await load();
}
