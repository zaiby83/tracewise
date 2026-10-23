import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeUrl, challengeFor, decodeJwt, handleCallback, idToken, pkcePair, prepareSignIn, signIn, signOut } from "../dashboard/console/auth.js";
import { AuthError, createApi, messageFor } from "../dashboard/console/api.js";
import { parseHash } from "../dashboard/console/router.js";

const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const cfg = { domain: "https://auth.example.invalid", clientId: "client123" };

// A minimal in-memory Storage, enough for the modules under test.
const memoryStorage = () => {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), dump: () => Object.fromEntries(m) };
};

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("console api client", () => {
	it("refreshes the token once on 401, then gives up", async () => {
		const getToken = vi.fn().mockResolvedValue("t");
		const fetch = vi.fn().mockResolvedValueOnce(res(401, {})).mockResolvedValueOnce(res(200, { ok: 1 }));
		expect(await createApi({ getToken, fetch }).get("/v1/orgs")).toEqual({ ok: 1 });
		expect(getToken).toHaveBeenLastCalledWith({ force: true });
		fetch.mockResolvedValue(res(401, {}));
		await expect(createApi({ getToken, fetch }).get("/v1/orgs")).rejects.toBeInstanceOf(AuthError);
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("sends the ID token and JSON", async () => {
		const getToken = vi.fn().mockResolvedValue("t");
		const fetch = vi.fn().mockResolvedValue(res(201, { id: "k1" }));
		const api = createApi({ getToken, fetch });
		expect(await api.post("/v1/orgs/o1/keys", { name: "ci" })).toEqual({ id: "k1" });
		const [path, init] = fetch.mock.calls[0]!;
		expect(path).toBe("/v1/orgs/o1/keys");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({ authorization: "Bearer t", "content-type": "application/json" });
		expect(init.body).toBe(JSON.stringify({ name: "ci" }));
		await api.get("/v1/orgs");
		expect(fetch.mock.calls[1]![1].body).toBeUndefined();
		expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty("content-type");
	});

	it("supports patch and del, including empty responses", async () => {
		const getToken = vi.fn().mockResolvedValue("t");
		const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => Promise.reject(new SyntaxError("empty")) });
		const api = createApi({ getToken, fetch });
		expect(await api.patch("/v1/orgs/o1", { name: "x" })).toEqual({});
		expect(await api.del("/v1/orgs/o1/keys/k1")).toEqual({});
		expect(fetch.mock.calls.map((c) => c[1].method)).toEqual(["PATCH", "DELETE"]);
	});

	it("throws AuthError without calling the API when there is no token", async () => {
		const fetch = vi.fn();
		await expect(createApi({ getToken: async () => null, fetch }).get("/v1/orgs")).rejects.toBeInstanceOf(AuthError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("throws a plain-language error carrying the status", async () => {
		const fetch = vi.fn().mockResolvedValue(res(404, { error: "not found" }));
		const err = (await createApi({ getToken: async () => "t", fetch }).get("/v1/orgs/o1").catch((e) => e)) as Error & { status: number };
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(AuthError);
		expect(err.message).toBe("Not found, or you don't have access.");
		expect(err.status).toBe(404);
	});

	it("explains limits in plain words", () => {
		expect(messageFor(409, { error: "limit reached", limit: "max_keys" })).toBe("You've reached your plan's limit (max_keys).");
		expect(messageFor(409, { error: "already a member" })).toBe("already a member");
		expect(messageFor(429, { error: "slow down" })).toBe("slow down");
		expect(messageFor(500, {})).toBe("Something went wrong (HTTP 500).");
		// The API Gateway authorizer's body has `message`, not `error`.
		expect(messageFor(403, { message: "Forbidden" } as never)).toBe("Something went wrong (HTTP 403).");
		expect(messageFor(500, null as never)).toBe("Something went wrong (HTTP 500).");
	});
});

describe("console routes", () => {
	it("parses routes", () => {
		expect(parseHash("")).toEqual({ view: "overview" });
		expect(parseHash("#/")).toEqual({ view: "overview" });
		expect(parseHash("#/traces")).toEqual({ view: "traces" });
		expect(parseHash("#/keys")).toEqual({ view: "keys" });
		expect(parseHash("#/team")).toEqual({ view: "team" });
		expect(parseHash("#/usage")).toEqual({ view: "usage" });
		expect(parseHash("#/settings")).toEqual({ view: "settings" });
		expect(parseHash("#/orgs/new")).toEqual({ view: "orgs-new" });
		expect(parseHash("#/invite/abc_DEF-1")).toEqual({ view: "invite", param: "abc_DEF-1" });
		expect(parseHash("#/invite/")).toEqual({ view: "overview" });
		expect(parseHash("#/invite/a b")).toEqual({ view: "overview" });
		expect(parseHash("#/nope")).toEqual({ view: "overview" });
	});
});

describe("console auth", () => {
	it("computes the RFC 7636 S256 challenge", async () => {
		expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("makes a 64-character base64url verifier and its challenge", async () => {
		const a = await pkcePair();
		const b = await pkcePair();
		expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.challenge).toBe(await challengeFor(a.verifier));
	});

	it("decodes a JWT payload", () => {
		expect(decodeJwt(`x.${btoa(JSON.stringify({ email: "a@x.io" })).replace(/=+$/, "")}.y`)).toEqual({ email: "a@x.io" });
		expect(decodeJwt(jwt({ name: "Zoë ✓" }))).toEqual({ name: "Zoë ✓" });
	});

	describe("with a browser", () => {
		let session: ReturnType<typeof memoryStorage>;
		let location: { origin: string; assign: ReturnType<typeof vi.fn> };
		let replaceState: ReturnType<typeof vi.fn>;
		beforeEach(() => {
			session = memoryStorage();
			location = { origin: "https://app.example.invalid", assign: vi.fn() };
			replaceState = vi.fn();
			vi.stubGlobal("sessionStorage", session);
			vi.stubGlobal("location", location);
			vi.stubGlobal("history", { replaceState });
		});
		afterEach(() => vi.unstubAllGlobals());

		it("builds the authorize and sign-up URLs", () => {
			const u = new URL(authorizeUrl(cfg, { challenge: "chal", state: "st" }));
			expect(u.origin + u.pathname).toBe("https://auth.example.invalid/oauth2/authorize");
			expect(Object.fromEntries(u.searchParams)).toEqual({
				response_type: "code",
				client_id: "client123",
				redirect_uri: "https://app.example.invalid/console/index.html",
				scope: "openid email profile",
				code_challenge_method: "S256",
				code_challenge: "chal",
				state: "st",
			});
			expect(new URL(authorizeUrl(cfg, { challenge: "c", state: "s", signup: true })).pathname).toBe("/signup");
		});

		it("stores the verifier and state when preparing a sign-in", async () => {
			const { signInUrl, signUpUrl } = await prepareSignIn(cfg);
			const url = new URL(signInUrl);
			const stored = session.dump();
			expect(new URL(signUpUrl).pathname).toBe("/signup");
			expect(new URL(signUpUrl).searchParams.get("state")).toBe(url.searchParams.get("state"));
			expect(Object.values(stored)).toContain(url.searchParams.get("state"));
			expect(url.searchParams.get("code_challenge")).toBe(await challengeFor(Object.values(stored).find((v) => v.length === 64)!));
		});

		async function pending() {
			const url = new URL((await prepareSignIn(cfg)).signInUrl);
			return { state: url.searchParams.get("state")! };
		}
		const callbackUrl = (qs: string) => new URL(`https://app.example.invalid/console/index.html?${qs}#/keys`);

		it("exchanges the code, keeps tokens out of the URL, and clears the verifier and state", async () => {
			const { state } = await pending();
			const id = jwt({ email: "a@x.io" });
			const fetch = vi.fn().mockResolvedValue(res(200, { id_token: id, access_token: "acc", refresh_token: "r1", expires_in: 3600 }));
			vi.stubGlobal("fetch", fetch);
			expect(await handleCallback(cfg, callbackUrl(`code=abc&state=${state}`))).toBe(true);

			const [url, init] = fetch.mock.calls[0]!;
			expect(url).toBe("https://auth.example.invalid/oauth2/token");
			expect(init.method).toBe("POST");
			expect(init.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
			const body = new URLSearchParams(init.body as string);
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("abc");
			expect(body.get("client_id")).toBe("client123");
			expect(body.get("redirect_uri")).toBe("https://app.example.invalid/console/index.html");
			expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);

			expect(replaceState).toHaveBeenCalledWith(null, "", "/console/index.html#/keys");
			const stored = session.dump();
			expect(Object.values(stored)).toEqual(["r1"]);
			expect(await idToken()).toBe(id);
			expect(fetch).toHaveBeenCalledTimes(1);
		});

		it("signIn redirects to the chosen entry point", async () => {
			await signIn(cfg);
			expect(new URL(location.assign.mock.calls[0]![0]).pathname).toBe("/oauth2/authorize");
			await signIn(cfg, { signup: true });
			expect(new URL(location.assign.mock.calls[1]![0]).pathname).toBe("/signup");
		});

		it("rejects a callback whose state does not match, without calling the token endpoint", async () => {
			await pending();
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			expect(await handleCallback(cfg, callbackUrl("code=abc&state=forged"))).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
			expect(session.dump()).toEqual({});
			expect(replaceState).toHaveBeenCalledWith(null, "", "/console/index.html#/keys");
		});

		it("rejects a callback with no pending sign-in, and ignores a plain page load", async () => {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			expect(await handleCallback(cfg, callbackUrl("code=abc&state=x"))).toBe(false);
			expect(await handleCallback(cfg, new URL("https://app.example.invalid/console/index.html"))).toBe(false);
			expect(fetch).not.toHaveBeenCalled();
		});

		it("clears the verifier and state even when the exchange fails", async () => {
			const { state } = await pending();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(400, { error: "invalid_grant" })));
			expect(await handleCallback(cfg, callbackUrl(`code=abc&state=${state}`))).toBe(false);
			expect(session.dump()).toEqual({});
		});

		it("refreshes an expiring token, keeps the rotated refresh token, and shares one in-flight refresh", async () => {
			const { state } = await pending();
			const first = vi.fn().mockResolvedValue(res(200, { id_token: jwt({ n: 1 }), refresh_token: "r1", expires_in: 30 }));
			vi.stubGlobal("fetch", first);
			await handleCallback(cfg, callbackUrl(`code=abc&state=${state}`));

			const second = vi.fn().mockResolvedValue(res(200, { id_token: jwt({ n: 2 }), refresh_token: "r2", expires_in: 3600 }));
			vi.stubGlobal("fetch", second);
			// Expires within 60 s, so both callers trigger a refresh, but only one request goes out.
			const [a, b] = await Promise.all([idToken(), idToken()]);
			expect(a).toBe(b);
			expect(decodeJwt(a!)).toEqual({ n: 2 });
			expect(second).toHaveBeenCalledTimes(1);
			const body = new URLSearchParams(second.mock.calls[0]![1].body as string);
			expect(Object.fromEntries(body)).toEqual({ grant_type: "refresh_token", client_id: "client123", refresh_token: "r1" });
			expect(Object.values(session.dump())).toEqual(["r2"]);

			// Fresh now; `force` refreshes anyway, with the rotated token.
			second.mockResolvedValue(res(200, { id_token: jwt({ n: 3 }), refresh_token: "r3", expires_in: 3600 }));
			expect(await idToken()).toBe(a);
			expect(decodeJwt((await idToken({ force: true }))!)).toEqual({ n: 3 });
			expect(new URLSearchParams(second.mock.calls[1]![1].body as string).get("refresh_token")).toBe("r2");
		});

		it("signs out locally when the refresh token is rejected, but not on a transient failure", async () => {
			session.setItem("tw_refresh", "dead");
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(503, {})));
			await expect(idToken({ force: true })).rejects.toThrow();
			expect(session.getItem("tw_refresh")).toBe("dead");
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(400, { error: "invalid_grant" })));
			expect(await idToken({ force: true })).toBeNull();
			expect(session.dump()).toEqual({});
			expect(await idToken()).toBeNull();
		});

		it("signs out by revoking the refresh token, clearing storage and redirecting to the Cognito logout", async () => {
			const fetch = vi.fn().mockResolvedValue(res(200, {}));
			vi.stubGlobal("fetch", fetch);
			session.setItem("tw_refresh", "r");
			session.setItem("tw_org", "o1");
			session.setItem("tw_pending_invite", "t");
			await signOut(cfg);
			expect(fetch).toHaveBeenCalledTimes(1);
			const [revokeUrl, init] = fetch.mock.calls[0]!;
			expect(revokeUrl).toBe("https://auth.example.invalid/oauth2/revoke");
			expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
			expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({ token: "r", client_id: "client123" });
			expect(session.dump()).toEqual({});
			const u = new URL(location.assign.mock.calls[0]![0]);
			expect(u.origin + u.pathname).toBe("https://auth.example.invalid/logout");
			expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "client123", logout_uri: "https://app.example.invalid/console/index.html" });
		});

		it("still signs out when revoking fails, and skips the call with no refresh token", async () => {
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
			session.setItem("tw_refresh", "r");
			session.setItem("tw_org", "o1");
			await signOut(cfg);
			expect(session.dump()).toEqual({});
			expect(location.assign).toHaveBeenCalledTimes(1);

			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			await signOut(cfg);
			expect(fetch).not.toHaveBeenCalled();
			expect(location.assign).toHaveBeenCalledTimes(2);
		});
	});
});
