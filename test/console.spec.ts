import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	countOwnedOrgs: vi.fn(),
	createInvite: vi.fn(),
	createKey: vi.fn(),
	createOrg: vi.fn(),
	acceptInvite: vi.fn(),
	listInvites: vi.fn(),
	listKeys: vi.fn(),
	listMembers: vi.fn(),
	removeMember: vi.fn(),
	revokeInvite: vi.fn(),
	revokeKey: vi.fn(),
	setRole: vi.fn(),
	startDeletion: vi.fn(),
	cancelDeletion: vi.fn(),
	updateProfile: vi.fn(),
	findOrgByName: vi.fn(),
}));
const accounts = vi.hoisted(() => ({ getMember: vi.fn(), getProfile: vi.fn(), listUserOrgs: vi.fn() }));
const tenants = vi.hoisted(() => ({ consumeCounter: vi.fn(), readCounter: vi.fn() }));
vi.mock("../services/console/store", () => store);
vi.mock("../services/shared/accounts", async (orig) => ({ ...(await orig<object>()), ...accounts }));
vi.mock("../services/shared/tenants", async (orig) => ({ ...(await orig<object>()), ...tenants }));
process.env.DELETION_QUEUE_URL = "https://sqs.test/deletion";

const { handler } = await import("../services/console/handler");
const { CONSOLE_ROUTES } = await import("../services/console/route-keys");
const { FREE_LIMITS } = await import("../services/shared/accounts");
const { DEFAULT_RUBRIC } = await import("../services/evals/judge-prompt");

const sqsSend = vi.spyOn(SQSClient.prototype, "send");
const cwSend = vi.spyOn(CloudWatchClient.prototype, "send");

type Claims = Record<string, unknown>;
const owner: Claims = { sub: "u1", email: "Owner@Example.com", email_verified: "true" };
interface Req { claims?: Claims | null; params?: Record<string, string>; body?: unknown; rawBody?: string }
const call = (routeKey: string, { claims = owner, params = {}, body, rawBody }: Req = {}) =>
	handler({
		routeKey,
		pathParameters: params,
		body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
		headers: {},
		requestContext: { authorizer: claims ? { jwt: { claims } } : undefined },
	} as never);
const parse = (r: { body?: string }) => JSON.parse(r.body ?? "null");

const profile = { pk: "ORG#o1", sk: "PROFILE", org_id: "o1", name: "Acme", status: "active", plan: "free", limits: FREE_LIMITS, rubric: null, evals_enabled: true, owner_count: 1, created_at: "t", created_by: "u1" };
const asMember = (role: "owner" | "member", sub = "u1") => accounts.getMember.mockResolvedValue({ org_id: "o1", sub, email: "x@y.z", role, joined_at: "t" });
const orgParams = { orgId: "o1", keyId: "k", sub: "s", inviteId: "i" };
const keyRecord = { org_id: "o1", key_id: "k1", name: "Default", scope: "write", prefix: "tw_ab12cd", key_hash: "SECRET-HASH", created_by: "u1", created_at: "t" };

beforeEach(() => {
	for (const fn of [...Object.values(store), ...Object.values(accounts), ...Object.values(tenants), sqsSend, cwSend]) fn.mockReset();
	accounts.getProfile.mockResolvedValue({ ...profile });
	sqsSend.mockResolvedValue({} as never);
	cwSend.mockResolvedValue({} as never);
	asMember("owner");
});

const orgRoutes = CONSOLE_ROUTES.filter((r) => r.includes("{orgId}"));
const ownerOnly = [
	"PATCH /v1/orgs/{orgId}",
	"DELETE /v1/orgs/{orgId}",
	"PATCH /v1/orgs/{orgId}/members/{sub}",
	"GET /v1/orgs/{orgId}/invites",
	"POST /v1/orgs/{orgId}/invites",
	"DELETE /v1/orgs/{orgId}/invites/{inviteId}",
];

describe("authorization", () => {
	it.each(orgRoutes)("%s returns 404 to a non-member", async (r) => {
		accounts.getMember.mockResolvedValue(null);
		const res = await call(r, { params: orgParams });
		expect(res.statusCode).toBe(404);
		expect(parse(res)).toEqual({ error: "not found" });
		for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
	});
	it.each(orgRoutes)("%s returns 404 when the org has no profile", async (r) => {
		accounts.getProfile.mockResolvedValue(null);
		expect((await call(r, { params: orgParams })).statusCode).toBe(404);
	});
	it.each(ownerOnly)("%s returns 403 to a plain member", async (r) => {
		asMember("member");
		const res = await call(r, { params: orgParams, body: { name: "x", role: "member", email: "a@b.io", confirm_name: "Acme" } });
		expect(res.statusCode).toBe(403);
		expect(parse(res)).toEqual({ error: "owner only" });
		for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
	});
	it.each(["deleting", "deleted"])("hides an org that is %s", async (status) => {
		accounts.getProfile.mockResolvedValue({ ...profile, status });
		expect((await call("GET /v1/orgs/{orgId}", { params: orgParams })).statusCode).toBe(404);
	});
	it("answers 401 without claims and 404 for an unknown route", async () => {
		expect((await call("GET /v1/orgs", { claims: null })).statusCode).toBe(401);
		expect((await call("GET /v1/orgs", { claims: {} })).statusCode).toBe(401);
		expect((await call("GET /v1/nothing")).statusCode).toBe(404);
		expect((await call("__proto__")).statusCode).toBe(404);
	});
	it("lets a member remove themselves but not someone else", async () => {
		asMember("member", "u2");
		store.removeMember.mockResolvedValue("ok");
		const other = await call("DELETE /v1/orgs/{orgId}/members/{sub}", { claims: { ...owner, sub: "u2" }, params: { orgId: "o1", sub: "u3" } });
		expect(other.statusCode).toBe(403);
		expect(store.removeMember).not.toHaveBeenCalled();
		const self = await call("DELETE /v1/orgs/{orgId}/members/{sub}", { claims: { ...owner, sub: "u2" }, params: { orgId: "o1", sub: "u2" } });
		expect(self.statusCode).toBe(200);
		expect(store.removeMember).toHaveBeenCalledWith("o1", "u2");
	});
	it("lets an owner remove another member", async () => {
		store.removeMember.mockResolvedValue("ok");
		expect((await call("DELETE /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u3" } })).statusCode).toBe(200);
		expect(store.removeMember).toHaveBeenCalledWith("o1", "u3");
	});
});

describe("orgs", () => {
	it("lists the caller's orgs", async () => {
		accounts.listUserOrgs.mockResolvedValue([{ org_id: "o1", name: "Acme", role: "owner" }]);
		const res = await call("GET /v1/orgs");
		expect(parse(res)).toEqual({ orgs: [{ org_id: "o1", name: "Acme", role: "owner" }] });
		expect(accounts.listUserOrgs).toHaveBeenCalledWith("u1");
	});
	it("returns the profile with the caller's role and the default rubric, without table keys", async () => {
		const res = await call("GET /v1/orgs/{orgId}", { params: { orgId: "o1" } });
		const body = parse(res);
		expect(body).toMatchObject({ org_id: "o1", name: "Acme", role: "owner", limits: FREE_LIMITS, default_rubric: DEFAULT_RUBRIC });
		expect(body).not.toHaveProperty("pk");
		expect(body).not.toHaveProperty("sk");
	});
	it("requires a verified email to create an org", async () => {
		const res = await call("POST /v1/orgs", { claims: { ...owner, email_verified: "false" }, body: { name: "A" } });
		expect(res.statusCode).toBe(403);
		expect(parse(res)).toEqual({ error: "verify your email first" });
		expect(store.createOrg).not.toHaveBeenCalled();
	});
	it("caps orgs per owner and per day, and reports the global cap", async () => {
		store.countOwnedOrgs.mockResolvedValueOnce(3);
		expect((await call("POST /v1/orgs", { body: { name: "A" } })).statusCode).toBe(429);
		expect(tenants.consumeCounter).not.toHaveBeenCalled();
		expect(cwSend).not.toHaveBeenCalled();

		store.countOwnedOrgs.mockResolvedValueOnce(0);
		tenants.consumeCounter.mockResolvedValueOnce(false);
		const res = await call("POST /v1/orgs", { body: { name: "A" } });
		expect(res.statusCode).toBe(429);
		expect(parse(res)).toEqual({ error: "sign-ups are paused, try again tomorrow" });
		expect(tenants.consumeCounter).toHaveBeenCalledWith(expect.stringMatching(/^global#orgs#\d{4}-\d{2}-\d{2}$/), 1, 100, expect.any(Number));
		expect(cwSend.mock.calls[0]![0].input).toMatchObject({ Namespace: "Tracewise/Limits", MetricData: [{ MetricName: "GlobalCapHit", Value: 1, Dimensions: [{ Name: "Cap", Value: "orgs" }] }] });
		expect(store.createOrg).not.toHaveBeenCalled();
	});
	it("still answers 429 when the metric can't be published", async () => {
		store.countOwnedOrgs.mockResolvedValue(0);
		tenants.consumeCounter.mockResolvedValue(false);
		cwSend.mockRejectedValueOnce(new Error("throttled"));
		expect((await call("POST /v1/orgs", { body: { name: "A" } })).statusCode).toBe(429);
	});
	it("creates an org for the caller and returns the key secret without its hash", async () => {
		store.countOwnedOrgs.mockResolvedValue(0);
		tenants.consumeCounter.mockResolvedValue(true);
		store.createOrg.mockResolvedValue({ org: { ...profile, pk: undefined, sk: undefined }, key: { record: keyRecord, secret: "tw_secret" } });
		const res = await call("POST /v1/orgs", { body: { name: " Acme " } });
		expect(res.statusCode).toBe(201);
		expect(store.createOrg).toHaveBeenCalledWith({ name: "Acme", owner: { sub: "u1", email: "owner@example.com" } });
		const body = parse(res);
		expect(body.org).toMatchObject({ org_id: "o1", role: "owner" });
		expect(body.key).toMatchObject({ key_id: "k1", scope: "write", prefix: "tw_ab12cd", secret: "tw_secret" });
		expect(res.body).not.toContain("SECRET-HASH");
		expect(res.body).not.toContain("key_hash");
	});
	it("validates rubric length and name length", async () => {
		const patch = (body: unknown) => call("PATCH /v1/orgs/{orgId}", { params: { orgId: "o1" }, body });
		store.updateProfile.mockResolvedValue({ ...profile });
		const long = await patch({ rubric: "x".repeat(4001) });
		expect(long.statusCode).toBe(400);
		expect(parse(long)).toMatchObject({ error: expect.any(String), issues: [{ path: "rubric" }] });
		expect((await patch({ name: "" })).statusCode).toBe(400);
		expect((await patch({ name: "x".repeat(101) })).statusCode).toBe(400);
		expect((await patch({})).statusCode).toBe(400);
		expect((await patch({ evals_enabled: "yes" })).statusCode).toBe(400);
		expect((await patch({ name: "x".repeat(100) })).statusCode).toBe(200);
		expect((await patch({ rubric: "x".repeat(4000) })).statusCode).toBe(200);
		expect((await patch({ rubric: null })).statusCode).toBe(200);
	});
	it("passes only the whitelisted fields to the store", async () => {
		store.updateProfile.mockResolvedValue({ ...profile, name: "New" });
		const res = await call("PATCH /v1/orgs/{orgId}", {
			params: { orgId: "o1" },
			body: { name: "New", limits: { max_keys: 9999 }, plan: "custom", status: "active", owner_count: 9 },
		});
		expect(res.statusCode).toBe(200);
		expect(store.updateProfile).toHaveBeenCalledWith("o1", { name: "New" });
		expect(parse(res)).toMatchObject({ name: "New", role: "owner" });
		expect(res.body).not.toContain('"pk"');
	});
	it("rejects a body that is not JSON", async () => {
		const res = await call("PATCH /v1/orgs/{orgId}", { params: { orgId: "o1" }, rawBody: "{nope" });
		expect(res.statusCode).toBe(400);
	});
	it("deletes only with the exact org name, then queues the deleter", async () => {
		store.startDeletion.mockResolvedValue(true);
		const del = (body: unknown) => call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body });
		expect((await del({ confirm_name: "acme" })).statusCode).toBe(400);
		expect((await del({})).statusCode).toBe(400);
		expect(store.startDeletion).not.toHaveBeenCalled();
		expect(sqsSend).not.toHaveBeenCalled();

		expect((await del({ confirm_name: "Acme" })).statusCode).toBe(202);
		expect(store.startDeletion).toHaveBeenCalledWith("o1");
		const cmd = sqsSend.mock.calls[0]![0] as { input: { QueueUrl: string; MessageBody: string } };
		expect(cmd.input.QueueUrl).toBe("https://sqs.test/deletion");
		expect(JSON.parse(cmd.input.MessageBody)).toEqual({ org_id: "o1", phase: "dynamo" });
	});
	it("doesn't roll back a deletion that was queued", async () => {
		store.startDeletion.mockResolvedValue(true);
		expect((await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } })).statusCode).toBe(202);
		expect(store.cancelDeletion).not.toHaveBeenCalled();
	});
	it("rolls the org back to active and answers 503 when the deleter can't be queued", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		store.startDeletion.mockResolvedValue(true);
		sqsSend.mockRejectedValue(new Error("queue down"));
		const res = await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } });
		expect(res.statusCode).toBe(503);
		expect(parse(res)).toEqual({ error: "couldn't start deletion, try again" });
		expect(store.cancelDeletion).toHaveBeenCalledWith("o1");
		expect(JSON.parse(String(err.mock.calls[0]![0]))).toEqual({ level: "error", msg: "deletion enqueue failed", org_id: "o1" });
		err.mockRestore();
	});
	it("still answers 503 when the rollback fails too", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		store.startDeletion.mockResolvedValue(true);
		sqsSend.mockRejectedValue(new Error("queue down"));
		store.cancelDeletion.mockRejectedValue(new Error("throttled"));
		const res = await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } });
		expect(res.statusCode).toBe(503);
		expect(err.mock.calls.map((c) => JSON.parse(String(c[0])))).toEqual([
			{ level: "error", msg: "deletion enqueue failed", org_id: "o1" },
			{ level: "error", msg: "deletion rollback failed", org_id: "o1" },
		]);
		err.mockRestore();
	});
	it("doesn't queue a second deletion when the org already left active", async () => {
		store.startDeletion.mockResolvedValue(false);
		const res = await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } });
		expect(res.statusCode).toBe(404);
		expect(sqsSend).not.toHaveBeenCalled();
	});
});

describe("keys", () => {
	it("returns the key secret only when it's created", async () => {
		store.listKeys.mockResolvedValue([]);
		store.createKey.mockResolvedValue({ record: keyRecord, secret: "tw_s3cret" });
		const created = await call("POST /v1/orgs/{orgId}/keys", { params: { orgId: "o1" }, body: { name: "CI", scope: "read" } });
		expect(created.statusCode).toBe(201);
		expect(parse(created).key.secret).toBe("tw_s3cret");
		expect(store.createKey).toHaveBeenCalledWith("o1", { name: "CI", scope: "read", created_by: "u1" });
		expect(created.body).not.toContain("SECRET-HASH");

		store.listKeys.mockResolvedValue([{ ...keyRecord, last_used_at: "2026-10-22T00:00:00Z" }]);
		const listed = await call("GET /v1/orgs/{orgId}/keys", { params: { orgId: "o1" } });
		expect(parse(listed).keys).toEqual([
			{ key_id: "k1", name: "Default", scope: "write", prefix: "tw_ab12cd", created_by: "u1", created_at: "t", last_used_at: "2026-10-22T00:00:00Z" },
		]);
		expect(listed.body).not.toContain("secret");
		expect(listed.body).not.toContain("key_hash");
		expect(listed.body).not.toContain("SECRET-HASH");
	});
	it("lets a plain member manage keys", async () => {
		asMember("member");
		store.listKeys.mockResolvedValue([]);
		store.createKey.mockResolvedValue({ record: keyRecord, secret: "tw_x" });
		store.revokeKey.mockResolvedValue(true);
		expect((await call("POST /v1/orgs/{orgId}/keys", { params: { orgId: "o1" }, body: { name: "CI", scope: "read" } })).statusCode).toBe(201);
		expect((await call("DELETE /v1/orgs/{orgId}/keys/{keyId}", { params: { orgId: "o1", keyId: "k1" } })).statusCode).toBe(200);
		expect(store.revokeKey).toHaveBeenCalledWith("o1", "k1");
	});
	it("answers 404 when the key to revoke is missing", async () => {
		store.revokeKey.mockResolvedValue(false);
		expect((await call("DELETE /v1/orgs/{orgId}/keys/{keyId}", { params: { orgId: "o1", keyId: "zz" } })).statusCode).toBe(404);
	});
	it("refuses a key past the limit with 409 max_keys", async () => {
		store.listKeys.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ ...keyRecord, key_id: `k${i}` })));
		const res = await call("POST /v1/orgs/{orgId}/keys", { params: { orgId: "o1" }, body: { name: "CI", scope: "read" } });
		expect(res.statusCode).toBe(409);
		expect(parse(res)).toEqual({ error: "limit reached", limit: "max_keys" });
		expect(store.createKey).not.toHaveBeenCalled();
	});
	it("validates the key body", async () => {
		store.listKeys.mockResolvedValue([]);
		for (const body of [{ name: "", scope: "read" }, { name: "x", scope: "admin" }, { name: "x" }]) {
			expect((await call("POST /v1/orgs/{orgId}/keys", { params: { orgId: "o1" }, body })).statusCode).toBe(400);
		}
	});
});

describe("team", () => {
	it("lists members with only the public fields", async () => {
		store.listMembers.mockResolvedValue([{ org_id: "o1", sub: "u1", email: "a@b.io", role: "owner", joined_at: "t", pk: "ORG#o1", sk: "MEMBER#u1" }]);
		const res = await call("GET /v1/orgs/{orgId}/members", { params: { orgId: "o1" } });
		expect(parse(res).members).toEqual([{ sub: "u1", email: "a@b.io", role: "owner", joined_at: "t" }]);
	});
	it("maps last-owner refusals to 409", async () => {
		store.setRole.mockResolvedValue("last_owner");
		const res = await call("PATCH /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u1" }, body: { role: "member" } });
		expect(res.statusCode).toBe(409);
		expect(parse(res)).toEqual({ error: "an organisation needs at least one owner" });
		store.removeMember.mockResolvedValue("last_owner");
		expect((await call("DELETE /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u1" } })).statusCode).toBe(409);
	});
	it("changes a role, and maps not_found to 404", async () => {
		store.setRole.mockResolvedValue("ok");
		const ok = await call("PATCH /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u2" }, body: { role: "owner" } });
		expect(ok.statusCode).toBe(200);
		expect(store.setRole).toHaveBeenCalledWith("o1", "u2", "owner");
		store.setRole.mockResolvedValue("not_found");
		expect((await call("PATCH /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u2" }, body: { role: "owner" } })).statusCode).toBe(404);
		store.removeMember.mockResolvedValue("not_found");
		expect((await call("DELETE /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u2" } })).statusCode).toBe(404);
		expect((await call("PATCH /v1/orgs/{orgId}/members/{sub}", { params: { orgId: "o1", sub: "u2" }, body: { role: "admin" } })).statusCode).toBe(400);
	});
	it("creates an invite and returns the link once", async () => {
		store.listMembers.mockResolvedValue([{ sub: "u1" }]);
		store.listInvites.mockResolvedValue([]);
		store.createInvite.mockResolvedValue({
			invite: { org_id: "o1", invite_id: "i1", token_hash: "TOKEN-HASH", email: "n@x.io", role: "member", created_by: "u1", created_at: "t", expires_at: 1234 },
			token: "tok",
			link: "https://d1/console/index.html#/invite/tok",
		});
		const res = await call("POST /v1/orgs/{orgId}/invites", { params: { orgId: "o1" }, body: { email: "n@x.io", role: "member" } });
		expect(res.statusCode).toBe(201);
		expect(parse(res)).toEqual({ invite_id: "i1", link: "https://d1/console/index.html#/invite/tok", expires_at: 1234 });
		expect(store.createInvite).toHaveBeenCalledWith("o1", { email: "n@x.io", role: "member", created_by: "u1" });
		expect(res.body).not.toContain("TOKEN-HASH");
		expect((await call("POST /v1/orgs/{orgId}/invites", { params: { orgId: "o1" }, body: { email: "not-an-email", role: "member" } })).statusCode).toBe(400);
	});
	it("lists pending invites without hashes", async () => {
		store.listInvites.mockResolvedValue([{ org_id: "o1", invite_id: "i1", token_hash: "TOKEN-HASH", email: "n@x.io", role: "member", created_by: "u1", created_at: "t", expires_at: 1234 }]);
		const res = await call("GET /v1/orgs/{orgId}/invites", { params: { orgId: "o1" } });
		expect(parse(res).invites).toEqual([{ invite_id: "i1", email: "n@x.io", role: "member", expires_at: 1234 }]);
		expect(res.body).not.toContain("TOKEN-HASH");
	});
	it("refuses a fifth member via invites when members + pending reach the limit", async () => {
		store.listMembers.mockResolvedValue([{}, {}, {}, {}]);
		store.listInvites.mockResolvedValue([{}]);
		const res = await call("POST /v1/orgs/{orgId}/invites", { params: { orgId: "o1" }, body: { email: "n@x.io", role: "member" } });
		expect(res.statusCode).toBe(409);
		expect(parse(res)).toEqual({ error: "limit reached", limit: "max_members" });
		expect(store.createInvite).not.toHaveBeenCalled();
	});
	it("refuses an invite past the pending limit", async () => {
		accounts.getProfile.mockResolvedValue({ ...profile, limits: { ...FREE_LIMITS, max_members: 50 } });
		store.listMembers.mockResolvedValue([{}]);
		store.listInvites.mockResolvedValue(Array.from({ length: 10 }, () => ({})));
		const res = await call("POST /v1/orgs/{orgId}/invites", { params: { orgId: "o1" }, body: { email: "n@x.io", role: "member" } });
		expect(parse(res)).toEqual({ error: "limit reached", limit: "max_pending_invites" });
	});
	it("revokes an invite, and answers 404 when it is gone", async () => {
		store.revokeInvite.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect((await call("DELETE /v1/orgs/{orgId}/invites/{inviteId}", { params: { orgId: "o1", inviteId: "i1" } })).statusCode).toBe(200);
		expect(store.revokeInvite).toHaveBeenCalledWith("o1", "i1");
		expect((await call("DELETE /v1/orgs/{orgId}/invites/{inviteId}", { params: { orgId: "o1", inviteId: "i1" } })).statusCode).toBe(404);
	});
});

describe("accepting invites", () => {
	it("accepts an invite with the invitee's claims, case-insensitively", async () => {
		store.acceptInvite.mockResolvedValue({ org_id: "o1" });
		const res = await call("POST /v1/invites/accept", { claims: { sub: "u2", email: "Alice@Example.com", email_verified: "true" }, body: { token: "t" } });
		expect(res.statusCode).toBe(200);
		expect(parse(res)).toEqual({ org_id: "o1" });
		expect(store.acceptInvite).toHaveBeenCalledWith("t", { sub: "u2", email: "alice@example.com", email_verified: true });
	});
	it("answers every refusal with the same 404", async () => {
		store.acceptInvite.mockResolvedValue(null);
		const res = await call("POST /v1/invites/accept", { body: { token: "t" } });
		expect(res.statusCode).toBe(404);
		expect(parse(res)).toEqual({ error: "not found" });
		expect((await call("POST /v1/invites/accept", { body: {} })).statusCode).toBe(400);
	});
});

describe("usage", () => {
	it("reports usage against limits, reading evals for yesterday", async () => {
		vi.useFakeTimers({ now: new Date("2026-10-22T10:30:00Z"), toFake: ["Date"] });
		tenants.readCounter.mockImplementation(async (id: string) => {
			if (id.includes("#evals#")) return id.endsWith("2026-10-21") ? 17 : 99;
			if (id.includes("#athena#")) return 4;
			if (id.includes("#day#")) return 1200;
			return 33;
		});
		store.listKeys.mockResolvedValue([{}, {}]);
		store.listMembers.mockResolvedValue([{}, {}, {}]);
		store.listInvites.mockResolvedValue([{}]);
		const res = await call("GET /v1/orgs/{orgId}/usage", { params: { orgId: "o1" } });
		vi.useRealTimers();
		expect(parse(res)).toEqual({
			limits: FREE_LIMITS,
			used: { events_this_minute: 33, events_today: 1200, analytics_queries_today: 4, eval_samples_last_night: 17, keys: 2, members: 3, pending_invites: 1 },
		});
	});
	it("is open to plain members", async () => {
		asMember("member");
		tenants.readCounter.mockResolvedValue(0);
		store.listKeys.mockResolvedValue([]);
		store.listMembers.mockResolvedValue([]);
		store.listInvites.mockResolvedValue([]);
		expect((await call("GET /v1/orgs/{orgId}/usage", { params: { orgId: "o1" } })).statusCode).toBe(200);
	});
});

describe("failures", () => {
	it("answers 500 and logs only the route, org and caller", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		store.createKey.mockRejectedValue(new Error("boom"));
		store.listKeys.mockResolvedValue([]);
		const res = await call("POST /v1/orgs/{orgId}/keys", { params: { orgId: "o1" }, body: { name: "do-not-log-me", scope: "read" } });
		expect(res.statusCode).toBe(500);
		expect(parse(res)).toEqual({ error: "internal error" });
		const line = String(err.mock.calls[0]![0]);
		expect(JSON.parse(line)).toMatchObject({ level: "error", route: "POST /v1/orgs/{orgId}/keys", org_id: "o1", sub: "u1" });
		expect(line).not.toContain("do-not-log-me");
		err.mockRestore();
	});
});
