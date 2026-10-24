import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

const ddb = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../services/shared/ddb", () => ({ ddb }));
process.env.ACCOUNTS_TABLE = "accounts";
process.env.TENANTS_TABLE = "tenants";
process.env.CONSOLE_ORIGIN = "https://d1.cloudfront.net";

const { FREE_LIMITS } = await import("../services/shared/accounts");
const { hashApiKey } = await import("../services/shared/keys");
const store = await import("../services/console/store");
const { acceptInvite, cancelDeletion, countOwnedOrgs, createInvite, createKey, createOrg, findOrgByName, listInvites, listKeys, listMembers, removeMember, revokeInvite, revokeKey, setRole, startDeletion, updateProfile } = store;

// Mocks are set per test (not in a hook), as in accounts.spec.ts. Every test starts from "send resolves {}".
const fresh = () => ddb.send.mockReset().mockResolvedValue({});
type Ctor<T> = new (...a: never[]) => T;
const sent = <T extends object>(cmd: Ctor<T>) => ddb.send.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof cmd);
const txItems = (n = 0) => sent(TransactWriteCommand)[n]!.input.TransactItems!;
const cancelled = (...codes: string[]) =>
	new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: codes.map((Code) => ({ Code })) });
const stamp = "2026-10-22T10:00:00.000Z";

afterEach(() => vi.useRealTimers());

describe("createOrg", () => {
	it("creates an org, its owner and a first key in one transaction", async () => {
		fresh();
		const { org, key } = await createOrg({ name: "Acme", owner: { sub: "u1", email: "a@x.io" } });
		const tx = txItems();
		expect(tx.map((i) => Object.keys(i)[0])).toEqual(["Put", "Put", "Put", "Put", "Put"]); // PROFILE, MEMBER, USER, KEY, key index
		expect(tx[0]!.Put!.Item).toMatchObject({ pk: `ORG#${org.org_id}`, sk: "PROFILE", plan: "free", limits: FREE_LIMITS, retention_days: 7, owner_count: 1, evals_enabled: true, rubric: null, status: "active" });
		expect(tx[1]!.Put!.Item).toMatchObject({ pk: `ORG#${org.org_id}`, sk: "MEMBER#u1", role: "owner", email: "a@x.io" });
		expect(tx[2]!.Put!.Item).toMatchObject({ pk: "USER#u1", sk: `ORG#${org.org_id}`, role: "owner", org_name: "Acme" });
		expect(tx[3]!.Put!.Item).toMatchObject({ pk: `ORG#${org.org_id}`, sk: `KEY#${key.record.key_id}`, scope: "write" });
		expect(tx[4]!.Put).toMatchObject({ TableName: "tenants", Item: { key_hash: hashApiKey(key.secret), org_id: org.org_id, key_id: key.record.key_id, scope: "write", status: "active" } });
		expect(key.secret).toMatch(/^tw_[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify(tx)).not.toContain(key.secret); // only the hash is stored
		expect(key.record.prefix).toBe(key.secret.slice(0, 9));
		expect(key.record.name).toBe("Default");
	});
	it("an operator-created org has no owner and owner_count 0", async () => {
		fresh();
		const { org } = await createOrg({ name: "Demo", plan: "custom", limits: { ...FREE_LIMITS, events_per_minute: 6000 } });
		const tx = txItems();
		expect(tx.map((i) => Object.keys(i)[0])).toEqual(["Put", "Put", "Put"]); // PROFILE, KEY, index
		expect(tx[0]!.Put!.Item).toMatchObject({ pk: `ORG#${org.org_id}`, owner_count: 0, plan: "custom", limits: { events_per_minute: 6000 } });
		expect(JSON.stringify(tx)).not.toContain("MEMBER#");
	});
	it("stamps 30-day retention on custom orgs and 7 on free ones", async () => {
		fresh();
		await createOrg({ name: "Demo", plan: "custom", limits: { ...FREE_LIMITS, events_per_minute: 6000 } });
		expect(txItems()[0]!.Put!.Item).toMatchObject({ retention_days: 30 });
		fresh();
		await createOrg({ name: "Acme", owner: { sub: "u1", email: "a@x.io" } });
		expect(txItems()[0]!.Put!.Item).toMatchObject({ retention_days: 7 });
	});
});

describe("updateProfile", () => {
	it("updates only the patched fields, allowing a null rubric", async () => {
		fresh().mockResolvedValueOnce({ Attributes: { org_id: "o1", rubric: null } });
		await updateProfile("o1", { rubric: null, evals_enabled: false });
		const input = sent(UpdateCommand)[0]!.input;
		expect(input.Key).toEqual({ pk: "ORG#o1", sk: "PROFILE" });
		expect(input.ConditionExpression).toBe("attribute_exists(pk)");
		expect(Object.values(input.ExpressionAttributeValues!)).toEqual([null, false]);
		expect(sent(TransactWriteCommand)).toHaveLength(0);
	});
	it("removes the named period fields in the same update", async () => {
		fresh().mockResolvedValueOnce({ Attributes: { org_id: "o1", plan: "custom" } });
		await updateProfile("o1", { plan: "custom", remove: ["period_start", "period_end"] });
		const input = sent(UpdateCommand)[0]!.input;
		expect(input.UpdateExpression).toBe("SET #plan = :plan REMOVE period_start, period_end");
		expect(input.ExpressionAttributeValues).toEqual({ ":plan": "custom" });
	});
	it("renaming updates org_name on every member's USER item", async () => {
		fresh()
			.mockResolvedValueOnce({ Items: [{ sub: "u1" }, { sub: "u2" }] }) // listMembers
			.mockResolvedValueOnce({}) // transaction
			.mockResolvedValueOnce({ Item: { org_id: "o1", name: "New" } }); // getProfile
		const p = await updateProfile("o1", { name: "New" });
		const tx = txItems();
		expect(tx).toHaveLength(3);
		expect(tx[0]!.Update!.Key).toEqual({ pk: "ORG#o1", sk: "PROFILE" });
		expect(tx.slice(1).map((i) => i.Update!.Key)).toEqual([{ pk: "USER#u1", sk: "ORG#o1" }, { pk: "USER#u2", sk: "ORG#o1" }]);
		expect(tx[1]!.Update!.ConditionExpression).toBe("attribute_exists(pk)");
		expect(p.name).toBe("New");
	});
	it("renaming splits past the 100-item transaction limit", async () => {
		const Items = Array.from({ length: 150 }, (_, i) => ({ sub: `u${i}` }));
		fresh().mockResolvedValueOnce({ Items });
		ddb.send.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ Item: { org_id: "o1" } });
		await updateProfile("o1", { name: "New" });
		expect(sent(TransactWriteCommand).map((c) => c.input.TransactItems!.length)).toEqual([100, 51]);
	});
	it("an empty patch just reads the profile", async () => {
		fresh().mockResolvedValueOnce({ Item: { org_id: "o1" } });
		expect((await updateProfile("o1", {})).org_id).toBe("o1");
		expect(sent(UpdateCommand)).toHaveLength(0);
	});
	it("rejects a profile that doesn't exist", async () => {
		fresh().mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
		await expect(updateProfile("nope", { evals_enabled: true })).rejects.toThrow(/not found/);
	});
});

describe("startDeletion", () => {
	it("only moves an active org to deleting", async () => {
		fresh();
		expect(await startDeletion("o1")).toBe(true);
		const input = sent(UpdateCommand)[0]!.input;
		expect(input.ConditionExpression).toBe("#s = :active");
		expect(input.ExpressionAttributeValues).toMatchObject({ ":active": "active", ":deleting": "deleting" });
	});
	it("returns false when the org isn't active", async () => {
		fresh().mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
		expect(await startDeletion("o1")).toBe(false);
	});
	it("rethrows other failures", async () => {
		fresh().mockRejectedValueOnce(new Error("throttled"));
		await expect(startDeletion("o1")).rejects.toThrow("throttled");
	});
});

describe("cancelDeletion", () => {
	it("only moves a deleting org back to active", async () => {
		fresh();
		expect(await cancelDeletion("o1")).toBe(true);
		const input = sent(UpdateCommand)[0]!.input;
		expect(input.Key).toEqual({ pk: "ORG#o1", sk: "PROFILE" });
		expect(input.UpdateExpression).toBe("SET #s = :active");
		expect(input.ConditionExpression).toBe("#s = :deleting");
		expect(input.ExpressionAttributeValues).toMatchObject({ ":active": "active", ":deleting": "deleting" });
	});
	it("returns false when the org isn't deleting", async () => {
		fresh().mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
		expect(await cancelDeletion("o1")).toBe(false);
	});
	it("rethrows other failures", async () => {
		fresh().mockRejectedValueOnce(new Error("throttled"));
		await expect(cancelDeletion("o1")).rejects.toThrow("throttled");
	});
});

describe("keys", () => {
	it("createKey writes the KEY item and the key-index row together, storing only the hash", async () => {
		fresh();
		const { record, secret } = await createKey("o1", { name: "ci", scope: "read", created_by: "u1" });
		const tx = txItems();
		expect(tx.map((i) => i.Put!.TableName)).toEqual(["accounts", "tenants"]);
		expect(tx[0]!.Put!.Item).toMatchObject({ pk: "ORG#o1", sk: `KEY#${record.key_id}`, name: "ci", scope: "read", key_hash: hashApiKey(secret), created_by: "u1" });
		expect(tx[1]!.Put!.Item).toMatchObject({ key_hash: hashApiKey(secret), org_id: "o1", scope: "read", status: "active" });
		expect(JSON.stringify(tx)).not.toContain(secret);
		expect(record.prefix).toBe(secret.slice(0, 9));
	});
	it("listKeys hides revoked keys and the table's own key attributes", async () => {
		fresh().mockResolvedValueOnce({
			Items: [
				{ pk: "ORG#o1", sk: "KEY#k1", key_id: "k1", name: "a" },
				{ pk: "ORG#o1", sk: "KEY#k2", key_id: "k2", name: "b", revoked_at: stamp },
			],
		});
		const keys = await listKeys("o1");
		expect(keys).toEqual([{ key_id: "k1", name: "a" }]);
		expect(sent(QueryCommand)[0]!.input.ExpressionAttributeValues).toEqual({ ":pk": "ORG#o1", ":p": "KEY#" });
	});
	it("revoking a key marks both the KEY item and the key-index row", async () => {
		fresh().mockResolvedValueOnce({ Item: { key_id: "k1", key_hash: "h1" } });
		expect(await revokeKey("o1", "k1")).toBe(true);
		const tx = txItems();
		expect(tx.map((i) => Object.keys(i)[0])).toEqual(["Update", "Update"]);
		expect(tx[0]!.Update).toMatchObject({ TableName: "accounts", Key: { pk: "ORG#o1", sk: "KEY#k1" } });
		expect(tx[0]!.Update!.UpdateExpression).toContain("revoked_at");
		expect(tx[1]!.Update).toMatchObject({ TableName: "tenants", Key: { key_hash: "h1" } });
		expect(tx[1]!.Update!.ExpressionAttributeValues).toMatchObject({ ":revoked": "revoked" });
	});
	it("revoking an unknown or already revoked key returns false", async () => {
		fresh().mockResolvedValueOnce({ Item: undefined });
		expect(await revokeKey("o1", "nope")).toBe(false);
		fresh().mockResolvedValueOnce({ Item: { key_id: "k1", key_hash: "h1" } }).mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None"));
		expect(await revokeKey("o1", "k1")).toBe(false);
	});
});

describe("members", () => {
	it("listMembers strips the table keys", async () => {
		fresh().mockResolvedValueOnce({ Items: [{ pk: "ORG#o1", sk: "MEMBER#u1", sub: "u1", role: "owner" }] });
		expect(await listMembers("o1")).toEqual([{ sub: "u1", role: "owner" }]);
	});
	it("setRole reports a missing member and no-ops an unchanged role", async () => {
		fresh().mockResolvedValueOnce({ Item: undefined });
		expect(await setRole("o1", "u1", "owner")).toBe("not_found");
		fresh().mockResolvedValueOnce({ Item: { role: "member" } });
		expect(await setRole("o1", "u1", "member")).toBe("ok");
		expect(sent(TransactWriteCommand)).toHaveLength(0);
	});
	it("promoting updates MEMBER, USER and adds to owner_count", async () => {
		fresh().mockResolvedValueOnce({ Item: { role: "member" } });
		expect(await setRole("o1", "u2", "owner")).toBe("ok");
		const tx = txItems();
		const profile = tx.find((i) => i.Update?.Key?.sk === "PROFILE")!.Update!;
		expect(profile.ExpressionAttributeValues).toMatchObject({ ":d": 1 });
		expect(tx.find((i) => i.Update?.Key?.sk === "MEMBER#u2")!.Update!.ExpressionAttributeValues).toMatchObject({ ":r": "owner", ":old": "member" });
		expect(tx.find((i) => i.Update?.Key?.pk === "USER#u2")!.Update!.ExpressionAttributeValues).toMatchObject({ ":r": "owner" });
	});
	it("demoting an owner is conditional on another owner existing", async () => {
		fresh().mockResolvedValueOnce({ Item: { role: "owner" } }).mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None", "None"));
		expect(await setRole("o1", "u1", "member")).toBe("last_owner");
		const profile = txItems().find((i) => i.Update?.Key?.sk === "PROFILE")!.Update!;
		expect(profile.ConditionExpression).toContain("owner_count > :one");
		expect(profile.ExpressionAttributeValues).toMatchObject({ ":d": -1, ":one": 1 });
	});
	it("setRole re-reads once when the member changed under it, then gives up", async () => {
		fresh()
			.mockResolvedValueOnce({ Item: { role: "member" } })
			.mockRejectedValueOnce(cancelled("None", "ConditionalCheckFailed", "None"))
			.mockResolvedValueOnce({ Item: { role: "owner" } }); // someone else already promoted them
		expect(await setRole("o1", "u2", "owner")).toBe("ok");
		fresh()
			.mockResolvedValueOnce({ Item: { role: "member" } })
			.mockRejectedValueOnce(cancelled("None", "ConditionalCheckFailed", "None"))
			.mockResolvedValueOnce({ Item: { role: "member" } })
			.mockRejectedValueOnce(cancelled("None", "ConditionalCheckFailed", "None"));
		await expect(setRole("o1", "u2", "owner")).rejects.toThrow(/concurrent/);
	});
	it("setRole rethrows failures that aren't a failed condition", async () => {
		fresh().mockResolvedValueOnce({ Item: { role: "member" } }).mockRejectedValueOnce(cancelled("ThrottlingError"));
		await expect(setRole("o1", "u2", "owner")).rejects.toBeInstanceOf(TransactionCanceledException);
		fresh().mockResolvedValueOnce({ Item: { role: "member" } }).mockRejectedValueOnce(new Error("boom"));
		await expect(setRole("o1", "u2", "owner")).rejects.toThrow("boom");
	});
	it("removing a plain member doesn't touch owner_count", async () => {
		fresh().mockResolvedValueOnce({ Item: { role: "member" } });
		expect(await removeMember("o1", "u2")).toBe("ok");
		const tx = txItems();
		expect(tx.map((i) => Object.keys(i)[0])).toEqual(["Delete", "Delete"]);
		expect(tx.map((i) => i.Delete!.Key)).toEqual([{ pk: "ORG#o1", sk: "MEMBER#u2" }, { pk: "USER#u2", sk: "ORG#o1" }]);
	});
	it("removing the last owner is refused", async () => {
		fresh().mockResolvedValueOnce({ Item: { role: "owner" } }).mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None", "None"));
		expect(await removeMember("o1", "u1")).toBe("last_owner");
		const profile = txItems().find((i) => i.Update?.Key?.sk === "PROFILE")!.Update!;
		expect(profile.ConditionExpression).toContain("owner_count > :one");
		expect(profile.ExpressionAttributeValues).toMatchObject({ ":d": -1 });
	});
	it("removing someone who isn't a member returns not_found", async () => {
		fresh().mockResolvedValueOnce({ Item: undefined });
		expect(await removeMember("o1", "ghost")).toBe("not_found");
	});
});

describe("invites", () => {
	it("stores invite emails normalised and only the token's hash", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(stamp));
		fresh();
		const { invite, token, link } = await createInvite("o1", { email: "  Alice@Example.com", role: "member", created_by: "u1" });
		expect(invite.email).toBe("alice@example.com");
		expect(link).toBe(`${process.env.CONSOLE_ORIGIN}/console/index.html#/invite/${token}`);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify(sent(TransactWriteCommand)[0]!.input)).not.toContain(token);
		expect(invite.expires_at).toBe(Math.floor(Date.now() / 1000) + 7 * 86_400);
		const tx = txItems();
		expect(tx[0]!.Put!.Item).toMatchObject({ pk: "ORG#o1", sk: `INVITE#${invite.invite_id}`, token_hash: hashApiKey(token), email: "alice@example.com", role: "member" });
		expect(tx[1]!.Put!.Item).toEqual({ pk: `INVITE#${hashApiKey(token)}`, sk: "INVITE", org_id: "o1", invite_id: invite.invite_id, expires_at: invite.expires_at });
	});
	it("listInvites drops invites past their expiry even before TTL removes them", async () => {
		const now = Date.parse(stamp);
		fresh().mockResolvedValueOnce({
			Items: [
				{ pk: "ORG#o1", sk: "INVITE#a", invite_id: "a", expires_at: now / 1000 + 60 },
				{ pk: "ORG#o1", sk: "INVITE#b", invite_id: "b", expires_at: now / 1000 - 1 },
			],
		});
		expect((await listInvites("o1", now)).map((i) => i.invite_id)).toEqual(["a"]);
	});
	it("revoking an invite deletes both items; unknown or used ones return false", async () => {
		fresh().mockResolvedValueOnce({ Item: { invite_id: "i1", token_hash: "th" } });
		expect(await revokeInvite("o1", "i1")).toBe(true);
		expect(txItems().map((i) => i.Delete!.Key)).toEqual([{ pk: "INVITE#th", sk: "INVITE" }, { pk: "ORG#o1", sk: "INVITE#i1" }]);
		fresh().mockResolvedValueOnce({ Item: undefined });
		expect(await revokeInvite("o1", "nope")).toBe(false);
		fresh().mockResolvedValueOnce({ Item: { invite_id: "i1", token_hash: "th" } }).mockRejectedValueOnce(cancelled("ConditionalCheckFailed", "None"));
		expect(await revokeInvite("o1", "i1")).toBe(false);
	});
});

describe("acceptInvite", () => {
	const now = Date.parse(stamp);
	const good = { sub: "u9", email: "Alice@Example.com", email_verified: true };
	// Reads, in order: the token lookup, the invite itself, the org's profile.
	const reads = (o: { role?: "owner" | "member"; expires_at?: number; status?: string; invite?: boolean } = {}) => {
		const expires_at = o.expires_at ?? now / 1000 + 3600;
		fresh()
			.mockResolvedValueOnce({ Item: { pk: "INVITE#th", sk: "INVITE", org_id: "o1", invite_id: "i1", expires_at } })
			.mockResolvedValueOnce({ Item: o.invite === false ? undefined : { org_id: "o1", invite_id: "i1", email: "alice@example.com", role: o.role ?? "member", expires_at } })
			.mockResolvedValueOnce({ Item: { org_id: "o1", name: "Acme", status: o.status ?? "active" } });
	};

	it.each([
		["wrong email", { email: "bob@x.io", email_verified: true }],
		["unverified email", { email: "alice@example.com", email_verified: false }],
	])("refuses to accept an invite with a %s", async (_n, claims) => {
		reads();
		expect(await acceptInvite("tok", { sub: "u9", ...claims }, now)).toBeNull();
		expect(sent(TransactWriteCommand)).toHaveLength(0);
	});
	it("refuses an unknown token, an expired invite and a deleting org", async () => {
		fresh().mockResolvedValueOnce({ Item: undefined });
		expect(await acceptInvite("tok", good, now)).toBeNull();
		reads({ expires_at: now / 1000 - 1 });
		expect(await acceptInvite("tok", good, now)).toBeNull();
		reads({ status: "deleting" });
		expect(await acceptInvite("tok", good, now)).toBeNull();
		reads({ invite: false });
		expect(await acceptInvite("tok", good, now)).toBeNull();
		expect(sent(TransactWriteCommand)).toHaveLength(0);
	});
	it("accepting adds the member and deletes the invite atomically, and a reuse gets null", async () => {
		reads();
		expect(await acceptInvite("tok", good, now)).toEqual({ org_id: "o1" });
		const tx = txItems();
		const member = tx.find((i) => i.Put?.Item?.sk === "MEMBER#u9")!.Put!;
		expect(member.ConditionExpression).toBe("attribute_not_exists(pk)");
		expect(member.Item).toMatchObject({ pk: "ORG#o1", org_id: "o1", sub: "u9", email: "alice@example.com", role: "member", joined_at: stamp });
		expect(tx.find((i) => i.Put?.Item?.pk === "USER#u9")!.Put!.Item).toMatchObject({ sk: "ORG#o1", role: "member", org_name: "Acme" });
		const dels = tx.filter((i) => i.Delete).map((i) => i.Delete!);
		expect(dels.map((d) => d.Key)).toEqual([{ pk: "INVITE#" + hashApiKey("tok"), sk: "INVITE" }, { pk: "ORG#o1", sk: "INVITE#i1" }]);
		for (const d of dels) expect(d.ConditionExpression).toBe("attribute_exists(pk)");
		expect(tx.some((i) => i.Update)).toBe(false); // a member invite leaves owner_count alone
		expect(tx.find((i) => i.ConditionCheck)!.ConditionCheck!.Key).toEqual({ pk: "ORG#o1", sk: "PROFILE" });
		reads();
		ddb.send.mockRejectedValueOnce(cancelled("None", "None", "ConditionalCheckFailed"));
		expect(await acceptInvite("tok", good, now)).toBeNull();
	});
	it("an owner invite adds to owner_count", async () => {
		reads({ role: "owner" });
		await acceptInvite("tok", good, now);
		const profile = txItems().find((i) => i.Update?.Key?.sk === "PROFILE")!.Update!;
		expect(profile.UpdateExpression).toContain("owner_count + :one");
		expect(txItems().some((i) => i.ConditionCheck)).toBe(false);
	});
	it("rethrows failures that aren't a failed condition", async () => {
		reads();
		ddb.send.mockRejectedValueOnce(new Error("boom"));
		await expect(acceptInvite("tok", good, now)).rejects.toThrow("boom");
	});
});

describe("org lookups", () => {
	it("countOwnedOrgs counts the user's owner rows across pages", async () => {
		fresh().mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: { pk: "x" } }).mockResolvedValueOnce({ Count: 1 });
		expect(await countOwnedOrgs("u1")).toBe(2);
		const q = sent(QueryCommand)[0]!.input;
		expect(q.ExpressionAttributeValues).toMatchObject({ ":pk": "USER#u1", ":owner": "owner" });
		expect(q.Select).toBe("COUNT");
	});
	it("findOrgByName scans profiles by name, skipping deleted orgs", async () => {
		fresh().mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: "x" } }).mockResolvedValueOnce({ Items: [{ org_id: "o1", name: "Acme" }] });
		expect((await findOrgByName("Acme"))?.org_id).toBe("o1");
		expect(sent(ScanCommand)[0]!.input.ExpressionAttributeValues).toMatchObject({ ":n": "Acme", ":deleted": "deleted" });
		fresh().mockResolvedValueOnce({ Items: [] });
		expect(await findOrgByName("Nobody")).toBeNull();
	});
});
