// Cognito sign-in for the console: authorization code + PKCE against the hosted UI.
// The ID token is the API bearer (it carries the email claims invitations need). It
// lives in memory only; the rotating refresh token lives in sessionStorage so a reload
// stays signed in but closing the tab doesn't. Nothing here touches the window until a
// function is called, so the module can be imported anywhere. No token, verifier or
// code is ever logged or put in a URL.

import { storage } from "../shared/dom.js";

const VERIFIER = "tw_pkce_verifier";
const STATE = "tw_pkce_state";
const REFRESH = "tw_refresh";
// Cleared on sign-out along with the auth keys; the shell owns both.
const SHELL_KEYS = ["tw_org", "tw_pending_invite"];
// Refresh when the token has less than this left, so a request never leaves with a token that expires in flight.
const SKEW_MS = 60_000;

let config = null;
let session = null; // { token, exp } in memory only
let refreshing = null;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const redirectUri = () => `${location.origin}/console/index.html`;

export async function challengeFor(verifier) {
	return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// 48 random bytes encode to exactly 64 base64url characters, inside RFC 7636's 43 to 128.
export async function pkcePair() {
	const verifier = random(48);
	return { verifier, challenge: await challengeFor(verifier) };
}

export function authorizeUrl(cfg, { challenge, state, signup = false }) {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: cfg.clientId,
		redirect_uri: redirectUri(),
		scope: "openid email profile",
		code_challenge_method: "S256",
		code_challenge: challenge,
		state,
	});
	return `${cfg.domain}${signup ? "/signup" : "/oauth2/authorize"}?${params}`;
}

// Stores a fresh verifier and state for the callback to check, and returns both entry points
// (sign in, create account), which share them: only one of the two will be followed.
export async function prepareSignIn(cfg) {
	const { verifier, challenge } = await pkcePair();
	const state = random(16);
	storage.set(sessionStorage, VERIFIER, verifier);
	storage.set(sessionStorage, STATE, state);
	return { signInUrl: authorizeUrl(cfg, { challenge, state }), signUpUrl: authorizeUrl(cfg, { challenge, state, signup: true }) };
}

export async function signIn(cfg, { signup = false } = {}) {
	const { signInUrl, signUpUrl } = await prepareSignIn(cfg);
	location.assign(signup ? signUpUrl : signInUrl);
}

function strip(url) {
	for (const k of ["code", "state", "error", "error_description"]) url.searchParams.delete(k);
	const qs = url.searchParams.toString();
	history.replaceState(null, "", url.pathname + (qs ? `?${qs}` : "") + url.hash);
}

async function tokenRequest(params) {
	return fetch(`${config.domain}/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: config.clientId, ...params }).toString(),
	});
}

function keep(tokens) {
	const exp = Date.now() + Number(tokens.expires_in ?? 3600) * 1000;
	session = { token: tokens.id_token, exp };
	// Rotation: every response carries a new refresh token that replaces the old one.
	if (tokens.refresh_token) storage.set(sessionStorage, REFRESH, tokens.refresh_token);
}

function clear() {
	session = null;
	for (const k of [VERIFIER, STATE, REFRESH]) storage.set(sessionStorage, k, null);
}

// Call once on every page load, before idToken(): it also hands the config to the refresh path.
// Returns true only when the URL was a valid sign-in callback and tokens were obtained.
export async function handleCallback(cfg, url) {
	config = cfg;
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code && !url.searchParams.has("error")) return false;

	// Both are single use: read them, then drop them before anything else can fail.
	const verifier = storage.get(sessionStorage, VERIFIER);
	const expected = storage.get(sessionStorage, STATE);
	storage.set(sessionStorage, VERIFIER, null);
	storage.set(sessionStorage, STATE, null);
	strip(url);

	if (!code || !verifier || !expected || state !== expected) return false;
	try {
		const res = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
		if (!res.ok) return false;
		keep(await res.json());
		return true;
	} catch {
		return false;
	}
}

async function refresh() {
	const refreshToken = storage.get(sessionStorage, REFRESH);
	if (!refreshToken) {
		session = null;
		return null;
	}
	const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
	if (res.status >= 400 && res.status < 500) {
		// The refresh token is expired, revoked or already rotated away: this session is over.
		clear();
		return null;
	}
	if (!res.ok) throw new Error("Couldn't reach the sign-in service. Try again in a moment.");
	keep(await res.json());
	return session.token;
}

// The current ID token, refreshed if it expires within a minute or `force` is set; null when signed out.
// Concurrent callers share one refresh, since a rotated refresh token can only be spent once.
export async function idToken({ force = false } = {}) {
	if (!force && session && session.exp - Date.now() > SKEW_MS) return session.token;
	refreshing ??= refresh().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

// Revokes the refresh token first (best effort, a few seconds at most), so a copy of it
// can't mint new tokens after sign-out. The local sign-out happens whatever the outcome.
export async function signOut(cfg) {
	const refreshToken = storage.get(sessionStorage, REFRESH);
	if (refreshToken) {
		try {
			await fetch(`${cfg.domain}/oauth2/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token: refreshToken, client_id: cfg.clientId }).toString(),
				signal: AbortSignal.timeout(3000),
			});
		} catch {
			// Offline or Cognito unreachable: sign out locally anyway; the token still expires.
		}
	}
	clear();
	for (const k of SHELL_KEYS) storage.set(sessionStorage, k, null);
	const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri() });
	location.assign(`${cfg.domain}/logout?${params}`);
}

export function decodeJwt(token) {
	const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
	const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes));
}
