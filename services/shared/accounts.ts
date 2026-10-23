import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PLANS } from "../billing/plans";
import { ddb } from "./ddb";

export type Role = "owner" | "member";
export type OrgStatus = "active" | "suspended" | "deleting" | "deleted";

export interface Limits {
	events_per_minute: number;
	// Per billing period; null means no cap (paid plans without a spend cap, custom orgs).
	monthly_events: number | null;
	eval_samples_per_night: number;
	analytics_queries_per_day: number;
	max_keys: number;
	max_members: number;
	max_pending_invites: number;
}

export const FREE_LIMITS: Limits = PLANS.free.limits;

export const MAX_OWNED_ORGS = 3;
export const GLOBAL_ORGS_PER_DAY = 100;
export const GLOBAL_JUDGE_CALLS_PER_NIGHT = 2000;
export const INVITE_TTL_DAYS = 7;

// Tenants that existed before self-serve keep today's behaviour: the free defaults would
// cap the public demo (polled every minute) and the load test, so they get no monthly cap.
export const legacyLimits = (eventsPerMinute: number): Limits => ({
	...FREE_LIMITS,
	events_per_minute: eventsPerMinute,
	monthly_events: null,
	analytics_queries_per_day: 10_000,
});

export interface OrgProfile {
	org_id: string;
	name: string;
	status: OrgStatus;
	plan: "free" | "team" | "pro" | "custom";
	limits: Limits;
	rubric: string | null;
	evals_enabled: boolean;
	// Kept atomically so "at least one owner" holds under concurrent demotions and removals.
	owner_count: number;
	created_at: string;
	created_by: string;
	deleted_at?: string;
	// Hot-retention days for this org's data; absent means the free default.
	retention_days?: number;
	// ISO dates of the paid billing period, written by the billing webhook.
	period_start?: string;
	period_end?: string;
}

export interface Member {
	org_id: string;
	sub: string;
	email: string;
	role: Role;
	joined_at: string;
}

export interface KeyRecord {
	org_id: string;
	key_id: string;
	name: string;
	scope: "read" | "write";
	// First characters of the key, enough to recognise it in a list.
	prefix: string;
	key_hash: string;
	created_by: string;
	created_at: string;
	last_used_at?: string;
	revoked_at?: string;
}

export interface Invite {
	org_id: string;
	invite_id: string;
	token_hash: string;
	email: string;
	role: Role;
	created_by: string;
	created_at: string;
	// Epoch seconds, so DynamoDB's TTL removes expired invites.
	expires_at: number;
}

// The ingest path's lookup row: one get by key hash resolves a key to its org.
export interface KeyIndexRow {
	key_hash: string;
	org_id: string;
	key_id: string;
	scope: "read" | "write";
	status: "active" | "revoked";
}

// Partition and sort key values for the single Accounts table.
export const k = {
	org: (id: string) => `ORG#${id}`,
	user: (sub: string) => `USER#${sub}`,
	member: (sub: string) => `MEMBER#${sub}`,
	key: (id: string) => `KEY#${id}`,
	invite: (id: string) => `INVITE#${id}`,
	inviteToken: (hash: string) => `INVITE#${hash}`,
};

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function getProfile(orgId: string): Promise<OrgProfile | null> {
	const { Item } = await ddb.send(
		new GetCommand({ TableName: process.env.ACCOUNTS_TABLE, Key: { pk: k.org(orgId), sk: "PROFILE" } }),
	);
	return (Item as OrgProfile | undefined) ?? null;
}

export async function getMember(orgId: string, sub: string): Promise<Member | null> {
	const { Item } = await ddb.send(
		new GetCommand({ TableName: process.env.ACCOUNTS_TABLE, Key: { pk: k.org(orgId), sk: k.member(sub) } }),
	);
	return (Item as Member | undefined) ?? null;
}

// The reverse membership rows (USER#sub / ORG#id) carry the org name, so listing a
// user's orgs needs no per-org lookups.
export async function listUserOrgs(sub: string): Promise<{ org_id: string; name: string; role: Role }[]> {
	const { Items = [] } = await ddb.send(
		new QueryCommand({
			TableName: process.env.ACCOUNTS_TABLE,
			KeyConditionExpression: "pk = :pk AND begins_with(sk, :org)",
			ExpressionAttributeValues: { ":pk": k.user(sub), ":org": "ORG#" },
		}),
	);
	return Items.map((i) => ({ org_id: String(i.sk).slice("ORG#".length), name: i.org_name, role: i.role }));
}

// A scan is fine here: the nightly jobs read it once, and profiles are a small slice of
// the table. Suspended, deleting and deleted orgs are skipped.
export async function listActiveProfiles(): Promise<OrgProfile[]> {
	return scanProfiles(true);
}

// Every profile, whatever its status: the nightly list uses it to recognise an org's old-shape
// key rows, so a deleting or suspended org isn't picked up again through them.
export async function listProfiles(): Promise<OrgProfile[]> {
	return scanProfiles(false);
}

async function scanProfiles(activeOnly: boolean): Promise<OrgProfile[]> {
	const profiles: OrgProfile[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(
			new ScanCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				FilterExpression: activeOnly ? "sk = :p AND #s = :active" : "sk = :p",
				...(activeOnly
					? { ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":p": "PROFILE", ":active": "active" } }
					: { ExpressionAttributeValues: { ":p": "PROFILE" } }),
				ExclusiveStartKey: startKey,
			}),
		);
		// The filter already applies server-side; checking again keeps the contract local.
		for (const item of page.Items ?? []) if (item.sk === "PROFILE" && (!activeOnly || item.status === "active")) profiles.push(item as OrgProfile);
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return profiles;
}

// Stamping last_used_at on every request would write once per ingest call, so each
// Lambda instance writes at most once an hour per key. Best effort: a failure here must
// never fail the request, and the condition stops it resurrecting a deleted key.
const TOUCH_MS = 3_600_000;
const touched = new Map<string, number>();

export function touchKey(orgId: string, keyId: string, now = Date.now()): void {
	const last = touched.get(keyId);
	if (last !== undefined && now - last < TOUCH_MS) return;
	touched.set(keyId, now);
	void ddb
		.send(
			new UpdateCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				Key: { pk: k.org(orgId), sk: k.key(keyId) },
				UpdateExpression: "SET last_used_at = :now",
				ConditionExpression: "attribute_exists(pk)",
				ExpressionAttributeValues: { ":now": new Date(now).toISOString() },
			}),
		)
		.catch(() => {});
}
