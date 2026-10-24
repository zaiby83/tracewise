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
const billingStore = vi.hoisted(() => ({ getBilling: vi.fn(), linkCustomer: vi.fn(), rememberCustomer: vi.fn(), setSpendCap: vi.fn() }));
const stripeModule = vi.hoisted(() => ({ getStripe: vi.fn(), findPortalConfigId: vi.fn(), stripeMode: vi.fn() }));
// A stub client: nothing here reaches the network.
const stripe = vi.hoisted(() => ({
	customers: { create: vi.fn() },
	prices: { list: vi.fn() },
	checkout: { sessions: { create: vi.fn(), list: vi.fn(), expire: vi.fn() } },
	billingPortal: { sessions: { create: vi.fn() } },
	subscriptions: { retrieve: vi.fn(), update: vi.fn(), list: vi.fn() },
}));
vi.mock("../services/console/store", () => store);
vi.mock("../services/billing/subscriptions", async (orig) => ({ ...(await orig<object>()), ...billingStore }));
vi.mock("../services/billing/stripe", () => stripeModule);
vi.mock("../services/shared/accounts", async (orig) => ({ ...(await orig<object>()), ...accounts }));
vi.mock("../services/shared/tenants", async (orig) => ({ ...(await orig<object>()), ...tenants }));
process.env.DELETION_QUEUE_URL = "https://sqs.test/deletion";
process.env.CONSOLE_ORIGIN = "https://d1.cloudfront.net";

const { handler } = await import("../services/console/handler");
const { CONSOLE_ROUTES } = await import("../services/console/route-keys");
const { resetPriceCache } = await import("../services/console/routes/billing");
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
	const stripeFns = [stripe.customers.create, stripe.prices.list, stripe.checkout.sessions.create, stripe.checkout.sessions.list, stripe.checkout.sessions.expire, stripe.billingPortal.sessions.create, stripe.subscriptions.retrieve, stripe.subscriptions.update, stripe.subscriptions.list];
	for (const fn of [...Object.values(store), ...Object.values(accounts), ...Object.values(tenants), ...Object.values(billingStore), ...Object.values(stripeModule), ...stripeFns, sqsSend, cwSend]) fn.mockReset();
	resetPriceCache();
	stripeModule.getStripe.mockResolvedValue(stripe);
	stripeModule.stripeMode.mockResolvedValue("test");
	stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
	stripe.subscriptions.list.mockResolvedValue({ data: [] });
	process.env.BILLING_CHECKOUT_ENABLED = "true";
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
	"POST /v1/orgs/{orgId}/billing/checkout",
	"POST /v1/orgs/{orgId}/billing/portal",
	"POST /v1/orgs/{orgId}/billing/change",
	"PATCH /v1/orgs/{orgId}/billing",
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
	it("leaves out orgs that are being deleted or have no profile", async () => {
		accounts.listUserOrgs.mockResolvedValue([
			{ org_id: "o1", name: "Acme", role: "owner" },
			{ org_id: "o2", name: "Going", role: "owner" },
			{ org_id: "o3", name: "Gone", role: "member" },
		]);
		accounts.getProfile.mockImplementation(async (id: string) => (id === "o1" ? { ...profile } : id === "o2" ? { ...profile, org_id: "o2", status: "deleting" } : null));
		expect(parse(await call("GET /v1/orgs"))).toEqual({ orgs: [{ org_id: "o1", name: "Acme", role: "owner" }] });
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
	it("stores an empty or whitespace-only rubric as null (the default), and trims the rest", async () => {
		store.updateProfile.mockResolvedValue({ ...profile });
		const patch = (body: unknown) => call("PATCH /v1/orgs/{orgId}", { params: { orgId: "o1" }, body });
		expect((await patch({ rubric: "   " })).statusCode).toBe(200);
		expect(store.updateProfile).toHaveBeenLastCalledWith("o1", { rubric: null });
		expect((await patch({ rubric: "" })).statusCode).toBe(200);
		expect(store.updateProfile).toHaveBeenLastCalledWith("o1", { rubric: null });
		expect((await patch({ rubric: "  be kind \n" })).statusCode).toBe(200);
		expect(store.updateProfile).toHaveBeenLastCalledWith("o1", { rubric: "be kind" });
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
	it.each(["active", "trialing", "past_due", "unpaid", "incomplete"])("refuses to delete an org whose Stripe subscription is %s", async (status) => {
		store.startDeletion.mockResolvedValue(true);
		billingStore.getBilling.mockResolvedValue({ org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status, plan: "team" });
		const res = await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } });
		expect(res.statusCode).toBe(409);
		expect(parse(res)).toEqual({ error: "cancel your subscription in Manage billing before deleting this organisation" });
		expect(store.startDeletion).not.toHaveBeenCalled();
		expect(sqsSend).not.toHaveBeenCalled();
	});
	it.each([
		["no billing record", null],
		["a billing account with no subscription", { org_id: "o1", customer_id: "cus_1", subscription_id: null, status: "none", plan: "free" }],
		["a canceled subscription", { org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "canceled", plan: "free" }],
		["an expired checkout", { org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "incomplete_expired", plan: "free" }],
	])("deletes an org with %s", async (_name, record) => {
		store.startDeletion.mockResolvedValue(true);
		billingStore.getBilling.mockResolvedValue(record);
		expect((await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } })).statusCode).toBe(202);
		expect(store.startDeletion).toHaveBeenCalledWith("o1");
	});
	it("deletes an org whose only subscription is from the other Stripe mode", async () => {
		stripeModule.stripeMode.mockResolvedValue("live");
		store.startDeletion.mockResolvedValue(true);
		billingStore.getBilling.mockResolvedValue({ org_id: "o1", customer_id: "cus_test", subscription_id: "sub_test", status: "active", plan: "team", livemode: false });
		expect((await call("DELETE /v1/orgs/{orgId}", { params: { orgId: "o1" }, body: { confirm_name: "Acme" } })).statusCode).toBe(202);
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
		store.listKeys.mockResolvedValue(Array.from({ length: FREE_LIMITS.max_keys }, (_, i) => ({ ...keyRecord, key_id: `k${i}` })));
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
	it("refuses an invite when members + pending reach the member limit", async () => {
		store.listMembers.mockResolvedValue([{}]);
		store.listInvites.mockResolvedValue([{}]);
		const res = await call("POST /v1/orgs/{orgId}/invites", { params: { orgId: "o1" }, body: { email: "n@x.io", role: "member" } });
		expect(res.statusCode).toBe(409);
		expect(parse(res)).toEqual({ error: "limit reached", limit: "max_members" });
		expect(store.createInvite).not.toHaveBeenCalled();
	});
	it("refuses an invite past the pending limit", async () => {
		accounts.getProfile.mockResolvedValue({ ...profile, limits: { ...FREE_LIMITS, max_members: 50 } });
		store.listMembers.mockResolvedValue([{}]);
		store.listInvites.mockResolvedValue(Array.from({ length: FREE_LIMITS.max_pending_invites }, () => ({})));
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
			if (id.includes("#month#")) return id === "o1#month#2026-10-01" ? 1234 : 99;
			return 33;
		});
		store.listKeys.mockResolvedValue([{}, {}]);
		store.listMembers.mockResolvedValue([{}, {}, {}]);
		store.listInvites.mockResolvedValue([{}]);
		const res = await call("GET /v1/orgs/{orgId}/usage", { params: { orgId: "o1" } });
		vi.useRealTimers();
		expect(parse(res)).toEqual({
			limits: FREE_LIMITS,
			period: { start: "2026-10-01", end: "2026-11-01" },
			used: { events_this_minute: 33, events_this_period: 1234, analytics_queries_today: 4, eval_samples_last_night: 17, keys: 2, members: 3, pending_invites: 1 },
		});
	});
	it("reads the paid period counter by the stored period start, and fills a missing monthly cap from the plan", async () => {
		const { monthly_events: _drop, ...old } = FREE_LIMITS;
		accounts.getProfile.mockResolvedValue({ ...profile, plan: "team", limits: old, period_start: "2026-10-15", period_end: "2026-11-15" });
		tenants.readCounter.mockResolvedValue(0);
		store.listKeys.mockResolvedValue([]);
		store.listMembers.mockResolvedValue([]);
		store.listInvites.mockResolvedValue([]);
		const res = await call("GET /v1/orgs/{orgId}/usage", { params: { orgId: "o1" } });
		expect(tenants.readCounter).toHaveBeenCalledWith("o1#paid#2026-10-15");
		expect(parse(res)).toMatchObject({ period: { start: "2026-10-15", end: "2026-11-15" }, limits: { monthly_events: null } });
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

const GET_BILLING = "GET /v1/orgs/{orgId}/billing";
const CHECKOUT = "POST /v1/orgs/{orgId}/billing/checkout";
const PORTAL = "POST /v1/orgs/{orgId}/billing/portal";
const CHANGE = "POST /v1/orgs/{orgId}/billing/change";
const PATCH_BILLING = "PATCH /v1/orgs/{orgId}/billing";
const o1 = { params: { orgId: "o1" } };
const paidProfile = (plan: "team" | "pro" = "team", over: object = {}) => ({ ...profile, plan, limits: { ...FREE_LIMITS, monthly_events: null }, period_start: "2026-10-10", period_end: "2026-11-10", ...over });
const billingRecord = (over: object = {}) => ({
	org_id: "o1", customer_id: "cus_1", subscription_id: "sub_1", status: "active", plan: "team",
	current_period_start: "2026-10-10T00:00:00.000Z", current_period_end: "2026-11-10T00:00:00.000Z",
	cancel_at_period_end: false, spend_cap_usd: null, past_due_since: null, reported_events: 0, reported_period: null, ...over,
});
// Price ids are derived from the lookup key, so a test can tell which key a call used.
const priceIdsByKey = () =>
	stripe.prices.list.mockImplementation(async ({ lookup_keys }: { lookup_keys: string[] }) => ({ data: lookup_keys.map((key) => ({ id: `price_${key}`, lookup_key: key })) }));
const stripeSub = (base = "team_monthly", metered = "team_metered") => ({
	id: "sub_1",
	status: "active",
	items: { data: [{ id: "si_metered", price: { id: `price_${metered}`, lookup_key: metered } }, { id: "si_base", price: { id: `price_${base}`, lookup_key: base } }] },
});

describe("billing", () => {
	it("shows billing to members but lets only owners change it", async () => {
		asMember("member");
		accounts.getProfile.mockResolvedValue(paidProfile());
		billingStore.getBilling.mockResolvedValue(billingRecord());
		tenants.readCounter.mockResolvedValue(0);
		expect((await call(GET_BILLING, o1)).statusCode).toBe(200);
		for (const [route, body] of [[CHECKOUT, { plan: "pro" }], [PORTAL, undefined], [CHANGE, { plan: "pro" }], [PATCH_BILLING, { spend_cap_usd: 5 }]] as const) {
			const res = await call(route, { ...o1, body });
			expect(res.statusCode, route).toBe(403);
			expect(parse(res)).toEqual({ error: "owner only" });
		}
		expect(stripeModule.getStripe).not.toHaveBeenCalled();
		expect(billingStore.setSpendCap).not.toHaveBeenCalled();
	});

	describe("GET", () => {
		it("reports a paid org's subscription, usage and estimated overage without any Stripe ids", async () => {
			vi.useFakeTimers({ now: new Date("2026-10-22T10:30:00Z"), toFake: ["Date"] });
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ cancel_at_period_end: true, spend_cap_usd: 10 }));
			tenants.readCounter.mockImplementation(async (id: string) => (id === "o1#paid#2026-10-10" ? 800_000 : 1));
			const res = await call(GET_BILLING, o1);
			vi.useRealTimers();
			expect(res.statusCode).toBe(200);
			expect(parse(res)).toEqual({
				plan: "team",
				status: "active",
				current_period_end: "2026-11-10T00:00:00.000Z",
				cancel_at_period_end: true,
				events_this_period: 800_000,
				included_events: 500_000,
				estimated_overage_usd: 15,
				spend_cap_usd: 10,
				past_due: false,
				billing_account: true,
				subscription_status: "active",
				checkout_enabled: true,
			});
			expect(res.body).not.toMatch(/cus_1|sub_1|price_|customer_id|subscription_id"/);
		});
		it("flags a past-due subscription", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("pro"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ plan: "pro", status: "past_due", past_due_since: "2026-10-20T00:00:00.000Z" }));
			tenants.readCounter.mockResolvedValue(0);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ plan: "pro", status: "past_due", past_due: true, included_events: 5_000_000 });
		});
		it("never reports a negative overage below the included events", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord());
			tenants.readCounter.mockResolvedValue(499_999);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ events_this_period: 499_999, estimated_overage_usd: 0 });
		});
		it("shows a free org with status none, null Stripe fields and the plan's allowance", async () => {
			tenants.readCounter.mockResolvedValue(1234);
			billingStore.getBilling.mockResolvedValue(null);
			expect(parse(await call(GET_BILLING, o1))).toEqual({
				plan: "free",
				status: "none",
				current_period_end: null,
				cancel_at_period_end: null,
				events_this_period: 1234,
				included_events: 50_000,
				estimated_overage_usd: 0,
				spend_cap_usd: null,
				past_due: false,
				billing_account: false,
				subscription_status: "none",
				checkout_enabled: true,
			});
		});
		it("shows a custom org with status none and no included allowance, ignoring any stale billing record", async () => {
			accounts.getProfile.mockResolvedValue({ ...profile, plan: "custom" });
			billingStore.getBilling.mockResolvedValue(billingRecord({ spend_cap_usd: 5 }));
			tenants.readCounter.mockResolvedValue(9_000_000);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ plan: "custom", status: "none", current_period_end: null, included_events: null, estimated_overage_usd: 0, spend_cap_usd: null });
		});
		it("reads a free org's usage from the month counter, even when it has a billing account", async () => {
			vi.useFakeTimers({ now: new Date("2026-10-22T10:30:00Z"), toFake: ["Date"] });
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "canceled", plan: "free" }));
			tenants.readCounter.mockImplementation(async (id: string) => (id === "o1#month#2026-10-01" ? 42 : 99));
			const res = await call(GET_BILLING, o1);
			vi.useRealTimers();
			expect(parse(res)).toMatchObject({ events_this_period: 42 });
		});
		it("tells a free org it still has a billing account, and what its subscription is doing, after a downgrade", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "unpaid", plan: "free" }));
			tenants.readCounter.mockResolvedValue(0);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ plan: "free", status: "none", past_due: false, billing_account: true, subscription_status: "unpaid" });
		});
		it("says whether paid plans can be bought", async () => {
			billingStore.getBilling.mockResolvedValue(null);
			tenants.readCounter.mockResolvedValue(0);
			delete process.env.BILLING_CHECKOUT_ENABLED;
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ checkout_enabled: false });
			process.env.BILLING_CHECKOUT_ENABLED = "false";
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ checkout_enabled: false });
		});
		it("shows no subscription when the record is from the other Stripe mode", async () => {
			stripeModule.stripeMode.mockResolvedValue("live");
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ spend_cap_usd: 10, livemode: false }));
			tenants.readCounter.mockResolvedValue(0);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ plan: "team", status: "none", current_period_end: null, cancel_at_period_end: null, spend_cap_usd: null, past_due: false, billing_account: false, subscription_status: "none" });
		});
		it("falls back to none for a paid org the webhook has not written a record for yet", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(null);
			tenants.readCounter.mockResolvedValue(0);
			expect(parse(await call(GET_BILLING, o1))).toMatchObject({ plan: "team", status: "none", current_period_end: null, spend_cap_usd: null });
		});
	});

	describe("checkout", () => {
		it("creates a Checkout session with base + metered prices, tax and the org reference", async () => {
			billingStore.getBilling.mockResolvedValue(null);
			priceIdsByKey();
			stripe.customers.create.mockResolvedValue({ id: "cus_new" });
			billingStore.rememberCustomer.mockImplementation(async (_org: string, id: string) => id);
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s1" });
			vi.useFakeTimers({ now: new Date("2026-10-22T10:00:00Z"), toFake: ["Date"] });
			const res = await call(CHECKOUT, { ...o1, body: { plan: "pro" } });
			vi.useRealTimers();
			expect(res.statusCode).toBe(200);
			expect(parse(res)).toEqual({ url: "https://checkout.stripe.test/s1" });
			expect(stripe.prices.list).toHaveBeenCalledWith({ lookup_keys: ["pro_monthly", "pro_metered"], active: true });
			expect(stripe.customers.create).toHaveBeenCalledWith({ email: "owner@example.com", metadata: { org_id: "o1" } }, { idempotencyKey: "customer-o1" });
			expect(billingStore.linkCustomer).toHaveBeenCalledWith("o1", "cus_new", false);
			expect(billingStore.rememberCustomer).toHaveBeenCalledWith("o1", "cus_new", false);
			expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
				mode: "subscription",
				customer: "cus_new",
				client_reference_id: "o1",
				line_items: [{ price: "price_pro_monthly", quantity: 1 }, { price: "price_pro_metered" }],
				subscription_data: { metadata: { org_id: "o1" } },
				automatic_tax: { enabled: true },
				customer_update: { address: "auto" },
				allow_promotion_codes: true,
				// 2026-10-22T10:00:00Z plus 31 minutes: Stripe's minimum is 30, and the request takes time.
				expires_at: Date.parse("2026-10-22T10:31:00Z") / 1000,
				success_url: "https://d1.cloudfront.net/console/index.html#/billing?checkout=success",
				cancel_url: "https://d1.cloudfront.net/console/index.html#/billing",
			});
		});
		it("links the customer before creating the session, and reuses an existing customer", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "canceled", subscription_id: null, plan: "free" }));
			priceIdsByKey();
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s2" });
			const res = await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(res.statusCode).toBe(200);
			expect(stripe.customers.create).not.toHaveBeenCalled();
			expect(billingStore.linkCustomer).not.toHaveBeenCalled();
			expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1", line_items: [{ price: "price_team_monthly", quantity: 1 }, { price: "price_team_metered" }] }));
		});
		it("answers 500 without creating a session when the customer belongs to another org", async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			billingStore.getBilling.mockResolvedValue(null);
			priceIdsByKey();
			stripe.customers.create.mockResolvedValue({ id: "cus_new" });
			billingStore.linkCustomer.mockRejectedValue(new Error("Stripe customer is already linked to a different org"));
			const res = await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(res.statusCode).toBe(500);
			expect(parse(res)).toEqual({ error: "internal error" });
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
			vi.mocked(console.error).mockRestore();
		});
		it.each(["active", "trialing"])("refuses checkout when already subscribed (%s)", async (status) => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status }));
			const res = await call(CHECKOUT, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "already subscribed, use Manage billing" });
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});
		it.each(["past_due", "unpaid", "incomplete"])("points at Manage billing when the subscription has a payment problem (%s)", async (status) => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status, plan: "free" }));
			const res = await call(CHECKOUT, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "there's a payment problem on your subscription — use Manage billing" });
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});
		it.each(["active", "trialing", "past_due", "incomplete", "unpaid"])("refuses checkout when Stripe already has a %s subscription the webhook hasn't recorded", async (status) => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "none", subscription_id: null, plan: "free" }));
			priceIdsByKey();
			stripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_9", status: "canceled" }, { id: "sub_2", status }] });
			const res = await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "already subscribed, use Manage billing" });
			expect(stripe.subscriptions.list).toHaveBeenCalledWith({ customer: "cus_1", status: "all", limit: 10 });
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});
		it("goes ahead when every subscription Stripe has for the customer has ended", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "canceled", plan: "free" }));
			priceIdsByKey();
			stripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_1", status: "canceled" }, { id: "sub_0", status: "incomplete_expired" }] });
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(200);
		});
		it.each([undefined, "false", "1"])("refuses checkout and plan changes while paid plans are switched off (%s)", async (flag) => {
			if (flag === undefined) delete process.env.BILLING_CHECKOUT_ENABLED;
			else process.env.BILLING_CHECKOUT_ENABLED = flag;
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(null);
			for (const route of [CHECKOUT, CHANGE]) {
				const res = await call(route, { ...o1, body: { plan: "pro" } });
				expect(res.statusCode, route).toBe(403);
				expect(parse(res)).toEqual({ error: "paid plans aren't available yet" });
			}
			expect(stripeModule.getStripe).not.toHaveBeenCalled();
		});
		it("keeps one customer across checkouts before any webhook, and expires the earlier open session first", async () => {
			// BILLING starts empty; rememberCustomer then creates it, as the real store does.
			let record: object | null = null;
			billingStore.getBilling.mockImplementation(async () => record);
			billingStore.rememberCustomer.mockImplementation(async (_org: string, id: string) => {
				record = billingRecord({ customer_id: id, status: "none", subscription_id: null, plan: "free" });
				return id;
			});
			priceIdsByKey();
			stripe.customers.create.mockResolvedValue({ id: "cus_new" });
			stripe.checkout.sessions.create.mockResolvedValueOnce({ id: "cs_1", url: "https://checkout.stripe.test/1" }).mockResolvedValueOnce({ id: "cs_2", url: "https://checkout.stripe.test/2" });
			stripe.checkout.sessions.list.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [{ id: "cs_1" }] });
			stripe.checkout.sessions.expire.mockResolvedValue({});

			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(200);
			expect((await call(CHECKOUT, { ...o1, body: { plan: "pro" } })).statusCode).toBe(200);

			expect(stripe.customers.create).toHaveBeenCalledTimes(1);
			expect(stripe.customers.create).toHaveBeenCalledWith(expect.anything(), { idempotencyKey: "customer-o1" });
			expect(stripe.checkout.sessions.list).toHaveBeenNthCalledWith(2, { customer: "cus_new", status: "open", limit: 100 });
			expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
			expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_1");
			const [firstCreate, secondCreate] = stripe.checkout.sessions.create.mock.invocationCallOrder as [number, number];
			expect(stripe.checkout.sessions.expire.mock.invocationCallOrder[0]!).toBeGreaterThan(firstCreate);
			expect(stripe.checkout.sessions.expire.mock.invocationCallOrder[0]!).toBeLessThan(secondCreate);
			expect(stripe.checkout.sessions.create.mock.calls.map(([a]) => a.customer)).toEqual(["cus_new", "cus_new"]);
		});
		it("uses whichever customer id was recorded first when two checkouts race", async () => {
			billingStore.getBilling.mockResolvedValue(null);
			priceIdsByKey();
			stripe.customers.create.mockResolvedValue({ id: "cus_mine" });
			billingStore.rememberCustomer.mockResolvedValue("cus_winner");
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
			await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(stripe.checkout.sessions.list).toHaveBeenCalledWith({ customer: "cus_winner", status: "open", limit: 100 });
			expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_winner" }));
		});
		it("ignores a session that expired or completed between the list and the expire, but not other failures", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "none", subscription_id: null, plan: "free" }));
			priceIdsByKey();
			stripe.checkout.sessions.list.mockResolvedValue({ data: [{ id: "cs_a" }, { id: "cs_b" }] });
			stripe.checkout.sessions.expire.mockRejectedValueOnce(Object.assign(new Error("not open"), { statusCode: 400 })).mockResolvedValueOnce({});
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(200);
			expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(2);

			vi.spyOn(console, "error").mockImplementation(() => {});
			stripe.checkout.sessions.create.mockClear();
			stripe.checkout.sessions.expire.mockReset().mockRejectedValue(Object.assign(new Error("down"), { statusCode: 500 }));
			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(500);
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
			vi.mocked(console.error).mockRestore();
		});
		it("starts a new live customer when the only record is test mode's, even one that was subscribed", async () => {
			stripeModule.stripeMode.mockResolvedValue("live");
			billingStore.getBilling.mockResolvedValue(billingRecord({ customer_id: "cus_test", status: "active", livemode: false }));
			priceIdsByKey();
			stripe.customers.create.mockResolvedValue({ id: "cus_live" });
			billingStore.rememberCustomer.mockImplementation(async (_org: string, id: string) => id);
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/live" });
			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(200);
			expect(billingStore.linkCustomer).toHaveBeenCalledWith("o1", "cus_live", true);
			expect(billingStore.rememberCustomer).toHaveBeenCalledWith("o1", "cus_live", true);
			expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_live" }));
		});
		it("refuses checkout for a custom org, whose plan the webhook never changes", async () => {
			accounts.getProfile.mockResolvedValue({ ...profile, plan: "custom" });
			billingStore.getBilling.mockResolvedValue(null);
			const res = await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(res.statusCode).toBe(409);
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});
		it.each([{ plan: "free" }, { plan: "enterprise" }, {}, undefined])("rejects the body %j with 400", async (body) => {
			expect((await call(CHECKOUT, { ...o1, body })).statusCode).toBe(400);
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
		});
		it("resolves each plan's prices once per instance", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "canceled" }));
			priceIdsByKey();
			stripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
			await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			await call(CHECKOUT, { ...o1, body: { plan: "team" } });
			expect(stripe.prices.list).toHaveBeenCalledTimes(1);
		});
		it("answers 500 when a price is not set up in Stripe", async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "canceled" }));
			stripe.prices.list.mockResolvedValue({ data: [{ id: "price_x", lookup_key: "team_monthly" }] });
			expect((await call(CHECKOUT, { ...o1, body: { plan: "team" } })).statusCode).toBe(500);
			expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
			vi.mocked(console.error).mockRestore();
		});
	});

	describe("portal", () => {
		it("refuses the portal before there's a customer", async () => {
			billingStore.getBilling.mockResolvedValue(null);
			const res = await call(PORTAL, o1);
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "no billing account yet" });
			expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
		});
		it("refuses the portal when the only customer is from the other Stripe mode", async () => {
			stripeModule.stripeMode.mockResolvedValue("live");
			billingStore.getBilling.mockResolvedValue(billingRecord({ livemode: false }));
			const res = await call(PORTAL, o1);
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "no billing account yet" });
			expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
		});
		it("opens the portal for a free org that still has a customer, so a downgraded org can settle or cancel", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ status: "unpaid", plan: "free" }));
			stripeModule.findPortalConfigId.mockResolvedValue("bpc_1");
			stripe.billingPortal.sessions.create.mockResolvedValue({ url: "https://billing.stripe.test/p2" });
			const res = await call(PORTAL, o1);
			expect(res.statusCode).toBe(200);
			expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_1" }));
		});
		it("opens a portal session on the maintained configuration", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord());
			stripeModule.findPortalConfigId.mockResolvedValue("bpc_1");
			stripe.billingPortal.sessions.create.mockResolvedValue({ url: "https://billing.stripe.test/p1" });
			const res = await call(PORTAL, o1);
			expect(parse(res)).toEqual({ url: "https://billing.stripe.test/p1" });
			expect(stripeModule.findPortalConfigId).toHaveBeenCalledWith(stripe);
			expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
				customer: "cus_1",
				configuration: "bpc_1",
				return_url: "https://d1.cloudfront.net/console/index.html#/billing",
			});
		});
		it("answers 500 and logs when the portal configuration has not been set up", async () => {
			const err = vi.spyOn(console, "error").mockImplementation(() => {});
			billingStore.getBilling.mockResolvedValue(billingRecord());
			stripeModule.findPortalConfigId.mockResolvedValue(null);
			const res = await call(PORTAL, o1);
			expect(res.statusCode).toBe(500);
			expect(parse(res)).toEqual({ error: "billing portal is not configured" });
			expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
			const line = JSON.parse(String(err.mock.calls[0]![0]));
			expect(line).toMatchObject({ level: "error", org_id: "o1", sub: "u1" });
			expect(JSON.stringify(line)).not.toContain("cus_1");
			err.mockRestore();
		});
	});

	describe("change", () => {
		it("swaps both subscription items to the new plan's prices with proration, and returns the billing view", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord());
			tenants.readCounter.mockResolvedValue(0);
			priceIdsByKey();
			stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
			stripe.subscriptions.update.mockResolvedValue({});
			const res = await call(CHANGE, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(200);
			expect(parse(res)).toMatchObject({ plan: "team", status: "active" });
			expect(res.body).not.toMatch(/cus_1|sub_1|price_|si_/);
			expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
			expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
				items: [{ id: "si_base", price: "price_pro_monthly" }, { id: "si_metered", price: "price_pro_metered" }],
				proration_behavior: "create_prorations",
			});
		});
		it.each([
			["no billing record", null],
			["a canceled subscription", billingRecord({ status: "canceled", plan: "free" })],
			["no subscription id", billingRecord({ subscription_id: null })],
			["a live record while the key is test", billingRecord({ livemode: true })],
		])("refuses with %s", async (_n, record) => {
			billingStore.getBilling.mockResolvedValue(record);
			const res = await call(CHANGE, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "no active subscription" });
			expect(stripe.subscriptions.update).not.toHaveBeenCalled();
		});
		it("refuses a switch to the plan Stripe's subscription is already on", async () => {
			billingStore.getBilling.mockResolvedValue(billingRecord({ plan: "pro" }));
			priceIdsByKey();
			stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("pro_monthly", "pro_metered"));
			const res = await call(CHANGE, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "already on that plan" });
			expect(stripe.subscriptions.update).not.toHaveBeenCalled();
		});
		it("goes ahead when our record is stale: it says team but Stripe is already on pro, and the owner wants team", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ plan: "team" }));
			tenants.readCounter.mockResolvedValue(0);
			priceIdsByKey();
			stripe.subscriptions.retrieve.mockResolvedValue(stripeSub("pro_monthly", "pro_metered"));
			stripe.subscriptions.update.mockResolvedValue({});
			expect((await call(CHANGE, { ...o1, body: { plan: "team" } })).statusCode).toBe(200);
			expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", expect.objectContaining({ items: [{ id: "si_base", price: "price_team_monthly" }, { id: "si_metered", price: "price_team_metered" }] }));
		});
		it.each(["canceled", "unpaid", "incomplete_expired"])("refuses when Stripe's retrieved subscription is %s", async (status) => {
			billingStore.getBilling.mockResolvedValue(billingRecord());
			stripe.subscriptions.retrieve.mockResolvedValue({ ...stripeSub(), status });
			const res = await call(CHANGE, { ...o1, body: { plan: "pro" } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "no active subscription" });
			expect(stripe.subscriptions.update).not.toHaveBeenCalled();
		});
		it("answers 500 when the subscription lacks the expected items", async () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			billingStore.getBilling.mockResolvedValue(billingRecord());
			priceIdsByKey();
			stripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "active", items: { data: [{ id: "si_x", price: { id: "price_other", lookup_key: null } }] } });
			expect((await call(CHANGE, { ...o1, body: { plan: "pro" } })).statusCode).toBe(500);
			expect(stripe.subscriptions.update).not.toHaveBeenCalled();
			vi.mocked(console.error).mockRestore();
		});
		it("rejects an unknown plan with 400", async () => {
			expect((await call(CHANGE, { ...o1, body: { plan: "free" } })).statusCode).toBe(400);
		});
	});

	describe("spend cap", () => {
		it("applies a spend cap below current usage immediately", async () => {
			// team at 800_000 events; a 10 USD cap allows 500_000 + 200_000, so ingest is blocked at once.
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ spend_cap_usd: 10 }));
			billingStore.setSpendCap.mockResolvedValue(true);
			tenants.readCounter.mockImplementation(async (id: string) => (id === "o1#paid#2026-10-10" ? 800_000 : 0));
			const res = await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: 10 } });
			expect(res.statusCode).toBe(200);
			expect(billingStore.setSpendCap).toHaveBeenCalledWith("o1", "team", 10);
			expect(parse(res)).toMatchObject({ plan: "team", events_this_period: 800_000, estimated_overage_usd: 15, spend_cap_usd: 10 });
		});
		it("clears a cap with null", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("pro"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ plan: "pro" }));
			billingStore.setSpendCap.mockResolvedValue(true);
			tenants.readCounter.mockResolvedValue(0);
			expect((await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: null } })).statusCode).toBe(200);
			expect(billingStore.setSpendCap).toHaveBeenCalledWith("o1", "pro", null);
		});
		it.each(["free", "custom"])("rejects caps on %s plans", async (plan) => {
			accounts.getProfile.mockResolvedValue({ ...profile, plan });
			const res = await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: 5 } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "spend caps apply to paid plans" });
			expect(billingStore.setSpendCap).not.toHaveBeenCalled();
		});
		it.each([-1, 100_001, "5", undefined])("rejects the cap %j with 400", async (cap) => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			expect((await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: cap } })).statusCode).toBe(400);
			expect(billingStore.setSpendCap).not.toHaveBeenCalled();
		});
		it("accepts the range's edges", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.getBilling.mockResolvedValue(billingRecord());
			billingStore.setSpendCap.mockResolvedValue(true);
			tenants.readCounter.mockResolvedValue(0);
			for (const cap of [0, 100_000]) expect((await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: cap } })).statusCode).toBe(200);
		});
		it("re-reads once when the plan changed under it, and applies the cap to the new plan", async () => {
			accounts.getProfile.mockResolvedValueOnce(paidProfile("team")).mockResolvedValue(paidProfile("pro"));
			billingStore.getBilling.mockResolvedValue(billingRecord({ plan: "pro" }));
			billingStore.setSpendCap.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			tenants.readCounter.mockResolvedValue(0);
			const res = await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: 10 } });
			expect(res.statusCode).toBe(200);
			expect(billingStore.setSpendCap.mock.calls).toEqual([["o1", "team", 10], ["o1", "pro", 10]]);
		});
		it("does not write a paid limit when the retry finds the org downgraded", async () => {
			accounts.getProfile.mockResolvedValueOnce(paidProfile("team")).mockResolvedValue({ ...profile });
			billingStore.setSpendCap.mockResolvedValueOnce(false);
			const res = await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: 10 } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "spend caps apply to paid plans" });
			expect(billingStore.setSpendCap).toHaveBeenCalledTimes(1);
		});
		it("answers 409 when the write keeps conflicting", async () => {
			accounts.getProfile.mockResolvedValue(paidProfile("team"));
			billingStore.setSpendCap.mockResolvedValue(false);
			const res = await call(PATCH_BILLING, { ...o1, body: { spend_cap_usd: 10 } });
			expect(res.statusCode).toBe(409);
			expect(parse(res)).toEqual({ error: "billing changed, try again" });
			expect(billingStore.setSpendCap).toHaveBeenCalledTimes(2);
		});
	});

	it("blocks new keys after a downgrade but keeps existing ones", async () => {
		// Five keys from a paid plan; free allows three. Nothing is deleted, only new creates stop.
		const keys = Array.from({ length: 5 }, (_, i) => ({ ...keyRecord, key_id: `k${i}` }));
		store.listKeys.mockResolvedValue(keys);
		const created = await call("POST /v1/orgs/{orgId}/keys", { ...o1, body: { name: "n", scope: "read" } });
		expect(created.statusCode).toBe(409);
		expect(parse(created)).toEqual({ error: "limit reached", limit: "max_keys" });
		expect(store.createKey).not.toHaveBeenCalled();
		const listed = await call("GET /v1/orgs/{orgId}/keys", o1);
		expect(parse(listed).keys).toHaveLength(5);
		expect(store.revokeKey).not.toHaveBeenCalled();
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
