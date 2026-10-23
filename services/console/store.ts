import { randomBytes, randomUUID } from "node:crypto";
import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
	INVITE_TTL_DAYS, k, getMember, getProfile, normalizeEmail,
	type Invite, type KeyRecord, type Limits, type Member, type OrgProfile, type Role,
} from "../shared/accounts";
import { PLANS } from "../billing/plans";
import { ddb } from "../shared/ddb";
import { hashApiKey, newApiKey } from "../shared/keys";

// Every write to the Accounts table lives here, so the rules that span items (a member and
// its reverse USER row, an invite and its token lookup, a key and its index row) are kept
// in one place. Handlers check permissions and caps; this layer keeps the data consistent.

type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
type Row = Record<string, unknown>;

const accounts = () => process.env.ACCOUNTS_TABLE;
const keyIndex = () => process.env.TENANTS_TABLE;
const transact = (items: TransactItem[]) => ddb.send(new TransactWriteCommand({ TransactItems: items }));
const profileKey = (orgId: string) => ({ pk: k.org(orgId), sk: "PROFILE" });

// Table keys are storage detail; callers get the records the types describe.
const strip = <T>(item: Row): T => {
	const { pk: _pk, sk: _sk, ...rest } = item;
	return rest as T;
};

// DynamoDB reports a failed condition on one item as ConditionalCheckFailedException and
// inside a transaction as a cancellation whose reasons line up with the items. Anything
// else (throttling, conflicts, validation) is a real error and must not become a domain answer.
const reasons = (e: unknown): string[] | null =>
	e instanceof TransactionCanceledException ? (e.CancellationReasons ?? []).map((r) => r.Code ?? "") : null;
const isConditionFailure = (e: unknown) =>
	e instanceof ConditionalCheckFailedException || (reasons(e)?.includes("ConditionalCheckFailed") ?? false);

async function queryAll(pk: string, prefix: string): Promise<Row[]> {
	const items: Row[] = [];
	let startKey: Row | undefined;
	do {
		const page = await ddb.send(
			new QueryCommand({
				TableName: accounts(),
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
				ExpressionAttributeValues: { ":pk": pk, ":p": prefix },
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...((page.Items ?? []) as Row[]));
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return items;
}

// ---- Orgs ----------------------------------------------------------------------------

// A key's KEY item and its key-index row are written together; the secret never leaves
// this function except in the result, and only its hash is stored.
function buildKey(orgId: string, input: { name: string; scope: "read" | "write"; created_by: string }, now: Date) {
	const secret = newApiKey();
	const record: KeyRecord = {
		org_id: orgId,
		key_id: randomUUID(),
		name: input.name,
		scope: input.scope,
		prefix: secret.slice(0, 9),
		key_hash: hashApiKey(secret),
		created_by: input.created_by,
		created_at: now.toISOString(),
	};
	const items: TransactItem[] = [
		{ Put: { TableName: accounts(), Item: { pk: k.org(orgId), sk: k.key(record.key_id), ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
		{
			Put: {
				TableName: keyIndex(),
				Item: { key_hash: record.key_hash, org_id: orgId, key_id: record.key_id, scope: record.scope, status: "active" },
				ConditionExpression: "attribute_not_exists(key_hash)",
			},
		},
	];
	return { record, secret, items };
}

// Operator-created orgs (the legacy migration, the demo) have no owner and owner_count 0.
export async function createOrg(input: {
	name: string;
	owner?: { sub: string; email: string };
	plan?: "free" | "custom";
	limits?: Limits;
}): Promise<{ org: OrgProfile; key: { record: KeyRecord; secret: string } }> {
	const now = new Date();
	const org: OrgProfile = {
		org_id: randomUUID(),
		name: input.name,
		status: "active",
		plan: input.plan ?? "free",
		limits: input.limits ?? { ...PLANS.free.limits },
		rubric: null,
		evals_enabled: true,
		owner_count: input.owner ? 1 : 0,
		created_at: now.toISOString(),
		created_by: input.owner?.sub ?? "operator",
		// Operator-created (custom) orgs keep the 30 days legacy tenants always had.
		retention_days: input.plan === "custom" ? 30 : PLANS.free.retention_days,
	};
	const key = buildKey(org.org_id, { name: "Default", scope: "write", created_by: org.created_by }, now);
	const items: TransactItem[] = [
		{ Put: { TableName: accounts(), Item: { ...profileKey(org.org_id), ...org }, ConditionExpression: "attribute_not_exists(pk)" } },
	];
	if (input.owner) {
		const member: Member = { org_id: org.org_id, sub: input.owner.sub, email: normalizeEmail(input.owner.email), role: "owner", joined_at: org.created_at };
		items.push(
			{ Put: { TableName: accounts(), Item: { pk: k.org(org.org_id), sk: k.member(member.sub), ...member }, ConditionExpression: "attribute_not_exists(pk)" } },
			{ Put: { TableName: accounts(), Item: { pk: k.user(member.sub), sk: k.org(org.org_id), role: "owner", org_name: org.name } } },
		);
	}
	await transact([...items, ...key.items]);
	return { org, key: { record: key.record, secret: key.secret } };
}

export async function updateProfile(
	orgId: string,
	patch: { name?: string; rubric?: string | null; evals_enabled?: boolean; limits?: Limits; plan?: "free" | "custom" },
): Promise<OrgProfile> {
	const names: Record<string, string> = {};
	const values: Record<string, unknown> = {};
	const sets: string[] = [];
	for (const [field, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		names[`#${field}`] = field;
		values[`:${field}`] = value;
		sets.push(`#${field} = :${field}`);
	}
	if (sets.length === 0) return (await getProfile(orgId)) as OrgProfile;
	const profile = {
		TableName: accounts(),
		Key: profileKey(orgId),
		UpdateExpression: `SET ${sets.join(", ")}`,
		ConditionExpression: "attribute_exists(pk)",
		ExpressionAttributeNames: names,
		ExpressionAttributeValues: values,
	};
	try {
		if (patch.name === undefined) {
			const { Attributes } = await ddb.send(new UpdateCommand({ ...profile, ReturnValues: "ALL_NEW" }));
			return Attributes as OrgProfile;
		}
		// The org name is copied onto each member's USER row (it powers "my orgs"), so a rename
		// rewrites them with the profile. The condition keeps a member removed in the meantime
		// from being resurrected as a half-empty row; the rename then fails and can be retried.
		const members = await listMembers(orgId);
		const userUpdates: TransactItem[] = members.map((m) => ({
			Update: {
				TableName: accounts(),
				Key: { pk: k.user(m.sub), sk: k.org(orgId) },
				UpdateExpression: "SET org_name = :n",
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeValues: { ":n": patch.name },
			},
		}));
		// A transaction holds 100 items: the profile goes in the first, the rest follow. A
		// failure part-way leaves some rows stale, and repeating the rename repairs them.
		const [first = [], ...rest] = chunks(userUpdates, 99, 100);
		await transact([{ Update: profile }, ...first]);
		for (const chunk of rest) await transact(chunk);
		return (await getProfile(orgId)) as OrgProfile;
	} catch (e) {
		if (isConditionFailure(e)) throw new Error("org not found or a member changed during the update");
		throw e;
	}
}

// First chunk has its own size (it shares a transaction with the profile update).
function chunks<T>(list: T[], first: number, size: number): T[][] {
	const out: T[][] = [list.slice(0, first)];
	for (let i = first; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

// True when this call moved the org to deleting; false when it wasn't active (already
// deleting, suspended or gone), so a repeated request doesn't start a second deletion.
export async function startDeletion(orgId: string): Promise<boolean> {
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: accounts(),
				Key: profileKey(orgId),
				UpdateExpression: "SET #s = :deleting",
				ConditionExpression: "#s = :active",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":active": "active", ":deleting": "deleting" },
			}),
		);
		return true;
	} catch (e) {
		if (isConditionFailure(e)) return false;
		throw e;
	}
}

// Undoes startDeletion when the deleter couldn't be queued, so the owner can try again.
// False when the org wasn't deleting any more.
export async function cancelDeletion(orgId: string): Promise<boolean> {
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: accounts(),
				Key: profileKey(orgId),
				UpdateExpression: "SET #s = :active",
				ConditionExpression: "#s = :deleting",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":active": "active", ":deleting": "deleting" },
			}),
		);
		return true;
	} catch (e) {
		if (isConditionFailure(e)) return false;
		throw e;
	}
}

// Scripts only. Names aren't unique, so this returns the first live match.
export async function findOrgByName(name: string): Promise<OrgProfile | null> {
	let startKey: Row | undefined;
	do {
		const page = await ddb.send(
			new ScanCommand({
				TableName: accounts(),
				FilterExpression: "sk = :p AND #n = :n AND #s <> :deleted",
				ExpressionAttributeNames: { "#n": "name", "#s": "status" },
				ExpressionAttributeValues: { ":p": "PROFILE", ":n": name, ":deleted": "deleted" },
				ExclusiveStartKey: startKey,
			}),
		);
		const hit = page.Items?.[0];
		if (hit) return strip<OrgProfile>(hit);
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return null;
}

export async function countOwnedOrgs(sub: string): Promise<number> {
	let count = 0;
	let startKey: Row | undefined;
	do {
		const page = await ddb.send(
			new QueryCommand({
				TableName: accounts(),
				KeyConditionExpression: "pk = :pk AND begins_with(sk, :o)",
				FilterExpression: "#r = :owner",
				ExpressionAttributeNames: { "#r": "role" },
				ExpressionAttributeValues: { ":pk": k.user(sub), ":o": "ORG#", ":owner": "owner" },
				Select: "COUNT",
				ExclusiveStartKey: startKey,
			}),
		);
		count += page.Count ?? 0;
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return count;
}

// ---- Keys ----------------------------------------------------------------------------

// Revoked keys stay in the table (for the audit trail) but aren't listed.
export async function listKeys(orgId: string): Promise<KeyRecord[]> {
	return (await queryAll(k.org(orgId), "KEY#")).filter((i) => !i.revoked_at).map((i) => strip<KeyRecord>(i));
}

export async function createKey(
	orgId: string,
	input: { name: string; scope: "read" | "write"; created_by: string },
): Promise<{ record: KeyRecord; secret: string }> {
	const { record, secret, items } = buildKey(orgId, input, new Date());
	await transact(items);
	return { record, secret };
}

// False when the key doesn't exist or is already revoked.
export async function revokeKey(orgId: string, keyId: string): Promise<boolean> {
	const { Item } = await ddb.send(new GetCommand({ TableName: accounts(), Key: { pk: k.org(orgId), sk: k.key(keyId) } }));
	if (!Item || Item.revoked_at) return false;
	try {
		await transact([
			{
				Update: {
					TableName: accounts(),
					Key: { pk: k.org(orgId), sk: k.key(keyId) },
					UpdateExpression: "SET revoked_at = :now",
					ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(revoked_at)",
					ExpressionAttributeValues: { ":now": new Date().toISOString() },
				},
			},
			{
				Update: {
					TableName: keyIndex(),
					Key: { key_hash: Item.key_hash },
					UpdateExpression: "SET #s = :revoked",
					ConditionExpression: "attribute_exists(key_hash)",
					ExpressionAttributeNames: { "#s": "status" },
					ExpressionAttributeValues: { ":revoked": "revoked" },
				},
			},
		]);
		return true;
	} catch (e) {
		if (isConditionFailure(e)) return false;
		throw e;
	}
}

// ---- Members -------------------------------------------------------------------------

export async function listMembers(orgId: string): Promise<Member[]> {
	return (await queryAll(k.org(orgId), "MEMBER#")).map((i) => strip<Member>(i));
}

// owner_count moves in the same transaction as the role, with `owner_count > 1` guarding a
// demotion or removal, so two owners leaving at once can't both succeed. The member item is
// conditioned on the role we read, so a concurrent role change can't double count.
// The profile update goes first: its cancellation reason is the one that means "last owner".
async function changeMembership(
	orgId: string,
	sub: string,
	build: (member: Member) => TransactItem[] | "ok",
): Promise<"ok" | "last_owner" | "not_found"> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const member = await getMember(orgId, sub);
		if (!member) return "not_found";
		const items = build(member);
		if (items === "ok") return "ok";
		try {
			await transact(items);
			return "ok";
		} catch (e) {
			const codes = reasons(e);
			if (!codes?.includes("ConditionalCheckFailed")) throw e;
			// A failed profile condition on a demotion or removal means this was the last owner.
			// Any other failed condition means the member changed since we read it: look again.
			if (member.role === "owner" && codes[0] === "ConditionalCheckFailed") return "last_owner";
		}
	}
	throw new Error("concurrent membership change, try again");
}

const ownerCountUpdate = (orgId: string, delta: 1 | -1): TransactItem => ({
	Update: {
		TableName: accounts(),
		Key: profileKey(orgId),
		UpdateExpression: "SET owner_count = owner_count + :d",
		ConditionExpression: delta === -1 ? "attribute_exists(pk) AND owner_count > :one" : "attribute_exists(pk)",
		ExpressionAttributeValues: delta === -1 ? { ":d": -1, ":one": 1 } : { ":d": 1 },
	},
});

export const setRole = (orgId: string, sub: string, role: Role) =>
	changeMembership(orgId, sub, (member) => {
		if (member.role === role) return "ok";
		const update = (key: Row): TransactItem => ({
			Update: {
				TableName: accounts(),
				Key: key,
				UpdateExpression: "SET #r = :r",
				ConditionExpression: "attribute_exists(pk) AND #r = :old",
				ExpressionAttributeNames: { "#r": "role" },
				ExpressionAttributeValues: { ":r": role, ":old": member.role },
			},
		});
		return [
			ownerCountUpdate(orgId, role === "owner" ? 1 : -1),
			update({ pk: k.org(orgId), sk: k.member(sub) }),
			update({ pk: k.user(sub), sk: k.org(orgId) }),
		];
	});

export const removeMember = (orgId: string, sub: string) =>
	changeMembership(orgId, sub, (member) => [
		...(member.role === "owner" ? [ownerCountUpdate(orgId, -1)] : []),
		{
			Delete: {
				TableName: accounts(),
				Key: { pk: k.org(orgId), sk: k.member(sub) },
				ConditionExpression: "attribute_exists(pk) AND #r = :old",
				ExpressionAttributeNames: { "#r": "role" },
				ExpressionAttributeValues: { ":old": member.role },
			},
		},
		{ Delete: { TableName: accounts(), Key: { pk: k.user(sub), sk: k.org(orgId) } } },
	]);

// ---- Invites -------------------------------------------------------------------------

export async function createInvite(
	orgId: string,
	input: { email: string; role: Role; created_by: string },
): Promise<{ invite: Invite; token: string; link: string }> {
	const now = Date.now();
	const token = randomBytes(32).toString("base64url");
	const invite: Invite = {
		org_id: orgId,
		invite_id: randomUUID(),
		token_hash: hashApiKey(token),
		email: normalizeEmail(input.email),
		role: input.role,
		created_by: input.created_by,
		created_at: new Date(now).toISOString(),
		expires_at: Math.floor(now / 1000) + INVITE_TTL_DAYS * 86_400,
	};
	// The second item lets accept find the invite from the token alone; only the hash is stored.
	await transact([
		{ Put: { TableName: accounts(), Item: { pk: k.org(orgId), sk: k.invite(invite.invite_id), ...invite }, ConditionExpression: "attribute_not_exists(pk)" } },
		{
			Put: {
				TableName: accounts(),
				Item: { pk: k.inviteToken(invite.token_hash), sk: "INVITE", org_id: orgId, invite_id: invite.invite_id, expires_at: invite.expires_at },
				ConditionExpression: "attribute_not_exists(pk)",
			},
		},
	]);
	return { invite, token, link: `${process.env.CONSOLE_ORIGIN}/console/index.html#/invite/${token}` };
}

// TTL removal can lag by up to two days, so expiry is checked here too.
export async function listInvites(orgId: string, now = Date.now()): Promise<Invite[]> {
	return (await queryAll(k.org(orgId), "INVITE#"))
		.filter((i) => Number(i.expires_at) * 1000 > now)
		.map((i) => strip<Invite>(i));
}

export async function revokeInvite(orgId: string, inviteId: string): Promise<boolean> {
	const { Item } = await ddb.send(new GetCommand({ TableName: accounts(), Key: { pk: k.org(orgId), sk: k.invite(inviteId) } }));
	if (!Item) return false;
	try {
		await transact(inviteDeletes(orgId, inviteId, Item.token_hash));
		return true;
	} catch (e) {
		if (isConditionFailure(e)) return false;
		throw e;
	}
}

// Both invite items go together; the conditions make a second delete (or an accept that won
// the race) fail rather than succeed twice.
const inviteDeletes = (orgId: string, inviteId: string, tokenHash: string): TransactItem[] => [
	{ Delete: { TableName: accounts(), Key: { pk: k.inviteToken(tokenHash), sk: "INVITE" }, ConditionExpression: "attribute_exists(pk)" } },
	{ Delete: { TableName: accounts(), Key: { pk: k.org(orgId), sk: k.invite(inviteId) }, ConditionExpression: "attribute_exists(pk)" } },
];

// Returns the org joined, or null for anything wrong with the token: unknown, expired, used,
// meant for another email, an unverified account, or an org that's being deleted. The caller
// answers all of those with the same 404, so nothing here says which it was.
export async function acceptInvite(
	token: string,
	claims: { sub: string; email: string; email_verified: boolean },
	now = Date.now(),
): Promise<{ org_id: string } | null> {
	if (!claims.email_verified) return null;
	const tokenHash = hashApiKey(token);
	const { Item: lookup } = await ddb.send(new GetCommand({ TableName: accounts(), Key: { pk: k.inviteToken(tokenHash), sk: "INVITE" } }));
	if (!lookup || Number(lookup.expires_at) * 1000 <= now) return null;
	const orgId = String(lookup.org_id);
	const { Item } = await ddb.send(new GetCommand({ TableName: accounts(), Key: { pk: k.org(orgId), sk: k.invite(String(lookup.invite_id)) } }));
	const invite = Item as Invite | undefined;
	if (!invite || invite.email !== normalizeEmail(claims.email)) return null;
	const profile = await getProfile(orgId);
	if (!profile || profile.status === "deleting" || profile.status === "deleted") return null;

	const member: Member = { org_id: orgId, sub: claims.sub, email: invite.email, role: invite.role, joined_at: new Date(now).toISOString() };
	// An owner invite also bumps owner_count (one update per item, so that is the profile
	// write); otherwise a plain check keeps the org from being deleted under us.
	const notDeleting = {
		ConditionExpression: "attribute_exists(pk) AND NOT (#s IN (:deleting, :deleted))",
		ExpressionAttributeNames: { "#s": "status" },
	};
	const deletingValues = { ":deleting": "deleting", ":deleted": "deleted" };
	const profileItem: TransactItem =
		invite.role === "owner"
			? {
					Update: {
						TableName: accounts(),
						Key: profileKey(orgId),
						UpdateExpression: "SET owner_count = owner_count + :one",
						...notDeleting,
						ExpressionAttributeValues: { ...deletingValues, ":one": 1 },
					},
				}
			: { ConditionCheck: { TableName: accounts(), Key: profileKey(orgId), ...notDeleting, ExpressionAttributeValues: deletingValues } };
	try {
		await transact([
			{ Put: { TableName: accounts(), Item: { pk: k.org(orgId), sk: k.member(member.sub), ...member }, ConditionExpression: "attribute_not_exists(pk)" } },
			{ Put: { TableName: accounts(), Item: { pk: k.user(member.sub), sk: k.org(orgId), role: member.role, org_name: profile.name } } },
			...inviteDeletes(orgId, invite.invite_id, tokenHash),
			profileItem,
		]);
		return { org_id: orgId };
	} catch (e) {
		if (isConditionFailure(e)) return null;
		throw e;
	}
}
