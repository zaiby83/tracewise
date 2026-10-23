// Hash routes: #/traces, #/orgs/new, #/invite/<token>. Anything unrecognised is the overview.

const VIEWS = new Set(["traces", "keys", "team", "usage", "settings"]);
// Invite tokens are base64url; anything else is not a token, so it isn't routed.
const TOKEN = /^[A-Za-z0-9_-]+$/;

export function parseHash(hash) {
	const [first, second] = hash.replace(/^#\/?/, "").split("/");
	if (first === "invite" && second && TOKEN.test(second)) return { view: "invite", param: second };
	if (first === "orgs" && second === "new") return { view: "orgs-new" };
	if (VIEWS.has(first)) return { view: first };
	return { view: "overview" };
}
