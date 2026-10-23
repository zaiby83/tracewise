// Accepting an invitation. The shell has already signed the person in (and carried the token
// through the sign-in redirect), so this only has to redeem it and switch to the new org.

import { el, storage } from "../../shared/dom.js";
import { ORG_KEY, pageHead } from "../ui.js";

const INVALID = "This invite is invalid, expired or for a different email address.";

export async function render(root, ctx) {
	root.replaceChildren(el("section", { class: "card narrow" }, pageHead("Joining…", "Accepting your invitation."), el("p", { class: "empty" }, "One moment…")));
	let joined;
	try {
		joined = await ctx.api.post("/v1/invites/accept", { token: ctx.param });
	} catch (err) {
		// A 404 is every way an invite can be wrong; other failures keep their own message.
		const message = err.status === 404 ? INVALID : err.message;
		root.replaceChildren(
			el("section", { class: "card narrow" }, pageHead("Couldn't accept the invite"), el("p", { class: "error", role: "alert" }, message), el("div", { class: "actions start" }, el("a", { class: "button", href: "#/" }, "Go to the console"))),
		);
		return;
	}
	storage.set(sessionStorage, ORG_KEY, joined.org_id);
	await ctx.refreshOrgs();
	ctx.navigate("#/");
}
