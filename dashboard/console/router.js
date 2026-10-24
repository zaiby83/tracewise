// Hash routes: #/traces, #/orgs/new, #/invite/<token>, #/billing?checkout=success. Anything unrecognised is the overview.

const VIEWS = new Set(["traces", "keys", "team", "usage", "settings"]);
// Invite tokens are base64url; anything else is not a token, so it isn't routed.
const TOKEN = /^[A-Za-z0-9_-]+$/;

export function parseHash(hash) {
	// Stripe sends people back to #/billing?checkout=success, so a query can ride in the fragment.
	const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
	const [first, second] = path.split("/");
	if (first === "invite" && second && TOKEN.test(second)) return { view: "invite", param: second };
	if (first === "orgs" && second === "new") return { view: "orgs-new" };
	if (first === "billing") return new URLSearchParams(query).get("checkout") === "success" ? { view: "billing", param: "success" } : { view: "billing" };
	if (VIEWS.has(first)) return { view: first };
	return { view: "overview" };
}
