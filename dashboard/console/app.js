// Tracewise console shell: sign-in, the org switcher and the header and nav, then each
// view in turn. Views live in views/<name>.js and export render(root, ctx). Plain DOM, no
// dependencies. Every value from the API goes in as text (el() never parses HTML).

import { $, el, storage } from "../shared/dom.js";
import { AuthError, createApi } from "./api.js";
import { decodeJwt, handleCallback, idToken, prepareSignIn, signOut } from "./auth.js";
import { parseHash } from "./router.js";

const ORG_KEY = "tw_org";
const INVITE_KEY = "tw_pending_invite";
const THEME_STORAGE = "tracewise_theme";
const NEW_ORG = "__new";
const TOKEN = /^[A-Za-z0-9_-]+$/;

const NAV = [
	["overview", "#/", "Overview"],
	["traces", "#/traces", "Traces"],
	["keys", "#/keys", "API keys"],
	["team", "#/team", "Team"],
	["usage", "#/usage", "Usage"],
	["settings", "#/settings", "Settings"],
];

let config = null;
let rawApi = null;
let api = null;
let me = null;
let orgs = [];
let org = null;
let signedIn = false;
let renderId = 0;
let signedOutId = 0;
let dropping = null;

// ---- Theme ------------------------------------------------------------------------------

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
const currentTheme = () => document.documentElement.dataset.theme || (prefersDark() ? "dark" : "light");

function applyTheme(theme) {
	if (theme) document.documentElement.dataset.theme = theme;
	else delete document.documentElement.dataset.theme;
	$("theme-button").setAttribute("aria-label", `Switch to ${currentTheme() === "dark" ? "light" : "dark"} theme`);
}

// ---- Screens ----------------------------------------------------------------------------

// Shows or hides everything that only makes sense when signed in.
function chrome(on) {
	$("signout-button").hidden = !on;
	$("who").hidden = !on;
	if (!on) {
		$("org-switch").hidden = true;
		$("nav").hidden = true;
	}
}

function card(...children) {
	$("view").replaceChildren(el("section", { class: "card auth-card" }, ...children));
}

function fatal(message, { retry = true } = {}) {
	signedIn = false;
	chrome(false);
	card(el("h1", {}, "Something went wrong"), el("p", { class: "error", role: "alert" }, message), retry ? el("div", { class: "actions" }, el("button", { class: "button primary", type: "button", onclick: () => location.reload() }, "Try again")) : null);
}

async function showSignedOut(message = "") {
	signedIn = false;
	const mine = ++signedOutId;
	const { view, param } = parseHash(location.hash);
	const invited = view === "invite";
	// The redirect to Cognito drops the URL fragment, so an invitation waits in session storage.
	if (invited) storage.set(sessionStorage, INVITE_KEY, param);
	chrome(false);
	let urls;
	try {
		urls = await prepareSignIn(config.auth);
	} catch {
		return fatal("Couldn't start sign-in in this browser.", { retry: false });
	}
	if (mine !== signedOutId) return;
	card(
		el("h1", {}, "Tracewise console"),
		invited ? el("p", { class: "invite" }, "You've been invited to join a team on Tracewise. Sign in or create an account to accept.") : el("p", {}, "Manage your organizations, API keys and team, and see your own traces and quality scores."),
		message ? el("p", { class: "error", role: "alert" }, message) : null,
		el("div", { class: "actions" }, el("a", { class: "button primary", href: urls.signUpUrl }, "Create an account"), el("a", { class: "button", href: urls.signInUrl }, "Sign in")),
	);
}

// ---- Orgs -------------------------------------------------------------------------------

// Loads the member's orgs and picks the current one: the saved choice if it is still
// there, otherwise the first.
async function loadOrgs() {
	const body = await rawApi.get("/v1/orgs");
	orgs = body.orgs ?? [];
	const saved = storage.get(sessionStorage, ORG_KEY);
	org = orgs.find((o) => o.org_id === saved) ?? orgs[0] ?? null;
	storage.set(sessionStorage, ORG_KEY, org ? org.org_id : null);
}

function renderHeader() {
	$("who").textContent = me.email ?? "";
	$("who").hidden = !me.email;
	const select = $("org-select");
	select.replaceChildren(...orgs.map((o) => el("option", { value: o.org_id, selected: o.org_id === org?.org_id }, o.name)), el("option", { value: NEW_ORG }, "New organization…"));
	$("org-switch").hidden = !orgs.length;
}

function renderNav(view) {
	$("nav").hidden = !org;
	$("nav-links").replaceChildren(...NAV.map(([name, href, label]) => el("a", { href, "aria-current": name === view ? "page" : null }, label)));
}

// A view got a 404 for the current org. If the list says the org is gone (deleted, or the
// member was removed), drop it and show whatever is next; otherwise the 404 was something
// narrower, like a key that no longer exists, and the view handles it.
function dropOrgIfGone() {
	if (!org || dropping) return dropping;
	const before = org.org_id;
	dropping = (async () => {
		try {
			await loadOrgs();
		} catch {
			return;
		}
		if (org?.org_id === before) return;
		renderHeader();
		route();
	})().finally(() => {
		dropping = null;
	});
	return dropping;
}

// Wraps the client so a view's failures reach the shell: an expired session goes back to
// sign-in, a 404 may mean the org itself is gone. The error still reaches the view.
function guarded(raw) {
	const wrap = (call) => async (...args) => {
		try {
			return await call(...args);
		} catch (err) {
			if (err instanceof AuthError) showSignedOut(err.message);
			else if (err.status === 404) await dropOrgIfGone();
			throw err;
		}
	};
	return { get: wrap(raw.get), post: wrap(raw.post), patch: wrap(raw.patch), del: wrap(raw.del) };
}

// ---- Routing ----------------------------------------------------------------------------

function navigate(hash) {
	if (location.hash === hash) route();
	else location.hash = hash;
}

async function refreshOrgs() {
	await loadOrgs();
	renderHeader();
	return orgs;
}

async function route() {
	if (!signedIn) return showSignedOut();
	const id = ++renderId;
	let { view, param } = parseHash(location.hash);
	// Without an org there is nothing to show but creating one (or accepting an invitation).
	if (!org && view !== "orgs-new" && view !== "invite") view = "orgs-new";
	renderNav(view);
	const root = el("div", { class: "view" });
	$("view").replaceChildren(root);
	try {
		const mod = await import(`./views/${view}.js`);
		if (id !== renderId) return;
		await mod.render(root, { api, org, orgs, me, navigate, refreshOrgs, param });
	} catch (err) {
		// A newer navigation replaced this view, or the session ended (the guard already showed sign-in).
		if (id !== renderId || err instanceof AuthError) return;
		const message = err instanceof TypeError || err instanceof SyntaxError ? "This page couldn't be loaded." : err.message;
		root.replaceChildren(el("div", { class: "banner view-error", role: "alert" }, el("span", {}, message), el("button", { class: "button", type: "button", onclick: route }, "Retry")));
	}
}

// ---- Startup ----------------------------------------------------------------------------

function wire() {
	applyTheme(storage.get(localStorage, THEME_STORAGE));
	$("theme-button").addEventListener("click", () => {
		const next = currentTheme() === "dark" ? "light" : "dark";
		storage.set(localStorage, THEME_STORAGE, next);
		applyTheme(next);
	});
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(document.documentElement.dataset.theme));

	$("signout-button").addEventListener("click", () => signOut(config.auth));
	$("org-select").addEventListener("change", (e) => {
		const value = e.target.value;
		if (value === NEW_ORG) {
			renderHeader();
			return navigate("#/orgs/new");
		}
		org = orgs.find((o) => o.org_id === value) ?? org;
		storage.set(sessionStorage, ORG_KEY, org.org_id);
		const { view } = parseHash(location.hash);
		// Leaving an org page for the new org's overview; anything else re-renders in place.
		navigate(view === "orgs-new" || view === "invite" ? "#/" : location.hash);
	});
	window.addEventListener("hashchange", route);
}

async function start() {
	try {
		me = decodeJwt(await idToken());
		rawApi = createApi({ getToken: idToken });
		api = guarded(rawApi);
		await loadOrgs();
	} catch (err) {
		return err instanceof AuthError ? showSignedOut(err.message) : fatal(err.message);
	}
	signedIn = true;
	chrome(true);
	renderHeader();
	// Back from sign-in with an invitation saved earlier: take its token out of storage and into the route.
	const pending = storage.get(sessionStorage, INVITE_KEY);
	storage.set(sessionStorage, INVITE_KEY, null);
	// replaceState rather than assigning location.hash: no hashchange, so the view renders once.
	if (pending && TOKEN.test(pending)) history.replaceState(null, "", `${location.pathname}${location.search}#/invite/${pending}`);
	route();
}

async function main() {
	wire();
	try {
		const res = await fetch("../config.json");
		config = await res.json();
		if (!res.ok || !config.auth?.domain || !config.auth?.clientId) throw new Error("incomplete");
	} catch {
		return fatal("The console isn't configured yet.", { retry: false });
	}
	const url = new URL(location.href);
	const wasCallback = url.searchParams.has("code") || url.searchParams.has("error");
	const ok = await handleCallback(config.auth, url);
	let token = null;
	try {
		token = await idToken();
	} catch (err) {
		return fatal(err.message);
	}
	if (!token) return showSignedOut(wasCallback && !ok ? "Sign-in didn't complete. Please try again." : "");
	start();
}
main();
