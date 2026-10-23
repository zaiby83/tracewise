import { beforeEach, describe, expect, it, vi } from "vitest";

const accounts = vi.hoisted(() => ({ getMember: vi.fn(), getProfile: vi.fn(), touchKey: vi.fn(), normalizeEmail: (e: string) => e.trim().toLowerCase() }));
vi.mock("../services/shared/accounts", () => accounts);
const tenants = vi.hoisted(() => ({ tenantForKey: vi.fn() }));
vi.mock("../services/shared/tenants", () => tenants);

const { FREE_LIMITS } = await vi.importActual<typeof import("../services/shared/accounts")>("../services/shared/accounts");
const { jwtClaims, resolveTenant } = await import("../services/shared/auth");

const jwtEvent = (claims: object, orgId = "o1") =>
	({ headers: {}, pathParameters: { orgId }, requestContext: { authorizer: { jwt: { claims } } } }) as never;
const profile = { org_id: "o1", name: "Acme", status: "active", limits: FREE_LIMITS, rubric: null, evals_enabled: true };

describe("jwtClaims", () => {
	it("reads string booleans from HTTP API claims", () => {
		expect(jwtClaims(jwtEvent({ sub: "u", email: "A@X.io", email_verified: "true" }))).toEqual({ sub: "u", email: "a@x.io", email_verified: true });
	});

	it("reads real booleans and treats anything else as unverified", () => {
		expect(jwtClaims(jwtEvent({ sub: "u", email: "a@x.io", email_verified: true }))?.email_verified).toBe(true);
		expect(jwtClaims(jwtEvent({ sub: "u", email: "a@x.io", email_verified: "false" }))?.email_verified).toBe(false);
	});

	it("is null without a subject, as on an API key request", () => {
		expect(jwtClaims({ headers: {}, requestContext: {} } as never)).toBeNull();
		expect(jwtClaims(jwtEvent({ email: "a@x.io" }))).toBeNull();
	});
});

describe("resolveTenant", () => {
	beforeEach(() => {
		accounts.getMember.mockReset();
		accounts.getProfile.mockReset();
		accounts.touchKey.mockReset();
		tenants.tenantForKey.mockReset();
	});

	it("resolves a member's org from the path", async () => {
		accounts.getMember.mockResolvedValue({ role: "member" });
		accounts.getProfile.mockResolvedValue(profile);
		const tenant = await resolveTenant(jwtEvent({ sub: "u", email: "a@x.io", email_verified: "true" }));
		expect(tenant).toMatchObject({ tenant_id: "o1", org_id: "o1", name: "Acme", scope: "read", status: "active" });
		expect(accounts.getMember).toHaveBeenCalledWith("o1", "u");
		expect(accounts.touchKey).not.toHaveBeenCalled();
	});

	it("gives a member's tenant the org's plan, retention and period", async () => {
		accounts.getMember.mockResolvedValue({ role: "member" });
		accounts.getProfile.mockResolvedValue({ ...profile, plan: "pro", period_start: "2026-10-15", period_end: "2026-11-15" });
		expect(await resolveTenant(jwtEvent({ sub: "u" }))).toMatchObject({ plan: "pro", retention_days: 90, period_start: "2026-10-15", period_end: "2026-11-15" });
	});

	it("returns null for a non-member or an inactive org", async () => {
		accounts.getMember.mockResolvedValueOnce(null);
		expect(await resolveTenant(jwtEvent({ sub: "u" }))).toBeNull();
		accounts.getMember.mockResolvedValueOnce({ role: "owner" });
		accounts.getProfile.mockResolvedValueOnce({ status: "deleting" });
		expect(await resolveTenant(jwtEvent({ sub: "u" }))).toBeNull();
	});

	it("returns null without an org in the path, and never falls back to a key", async () => {
		const event = { headers: { authorization: `Bearer tw_${"a".repeat(43)}` }, requestContext: { authorizer: { jwt: { claims: { sub: "u" } } } } } as never;
		expect(await resolveTenant(event)).toBeNull();
		expect(accounts.getMember).not.toHaveBeenCalled();
		expect(tenants.tenantForKey).not.toHaveBeenCalled();
	});

	it("falls back to the API key when there are no claims", async () => {
		tenants.tenantForKey.mockResolvedValue({ tenant_id: "t", org_id: "t", key_id: "k" });
		await resolveTenant({ headers: { authorization: `Bearer tw_${"a".repeat(43)}` }, requestContext: {} } as never);
		expect(accounts.touchKey).toHaveBeenCalledWith("t", "k");
	});

	it("returns null for a missing or unknown key, and skips touchKey for legacy tenants", async () => {
		expect(await resolveTenant({ headers: {}, requestContext: {} } as never)).toBeNull();
		tenants.tenantForKey.mockResolvedValueOnce(null);
		expect(await resolveTenant({ headers: { authorization: `Bearer tw_${"a".repeat(43)}` }, requestContext: {} } as never)).toBeNull();
		tenants.tenantForKey.mockResolvedValueOnce({ tenant_id: "t", org_id: "t" });
		await resolveTenant({ headers: { authorization: `Bearer tw_${"a".repeat(43)}` }, requestContext: {} } as never);
		expect(accounts.touchKey).not.toHaveBeenCalled();
	});
});
