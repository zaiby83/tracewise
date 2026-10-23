import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { k, legacyLimits, normalizeEmail, type KeyIndexRow, type KeyRecord, type Member, type OrgProfile, type OrgStatus } from "../../services/shared/accounts";
import { ddb } from "../../services/shared/ddb";

// The key index as it was before self-serve: one row per key, carrying the tenant's fields.
export interface LegacyRow {
	key_hash: string;
	tenant_id: string;
	name: string;
	status: string;
	events_per_minute: number;
	scope?: "read" | "write";
	rubric?: string;
	created_at: string;
	// Present once the row has been rewritten to the lean shape.
	org_id?: string;
}

export interface MigrationPlan {
	profiles: OrgProfile[];
	members: Member[];
	keys: KeyRecord[];
	index: KeyIndexRow[];
}

// What the scan found for an org that already has a profile.
export interface ExistingProfile {
	name: string;
	status: OrgStatus;
	owner_count: number;
}

// What was read from AWS, which applyPlan needs beside the plan: the raw status of each row
// (to guard the rewrite) and the profiles (for an org's name).
export interface Scan {
	rows: LegacyRow[];
	profiles: Map<string, ExistingProfile>;
}

// Pure: decides what to write and touches nothing, so a re-run is easy to reason about.
// Everything is derived from the rows, and key ids from the key hash, so the same input
// always plans the same items; rows already rewritten (they have an org_id) plan nothing.
//
// Existing profiles come as a Set of ids, or a Map with what the scan saw. With the Map:
// - a row whose org isn't active (deleting, deleted, suspended) is retired: its index row is
//   rewritten as revoked, with no KEY item. Leaving it in the old shape would leave the key
//   working at ingest, which accepts any old-shape row, and the deleter only reaches index
//   rows through KEY items;
// - with an owner, an active profile with no owners gets a membership, which is how a later
//   run claims orgs migrated before the operator had an account.
// A bare Set carries no status or owner count, so it plans neither.
export function planMigration(
	rows: LegacyRow[],
	existingProfiles: Set<string> | Map<string, ExistingProfile>,
	owner?: { sub: string; email: string },
	now = new Date().toISOString(),
): MigrationPlan {
	const plan: MigrationPlan = { profiles: [], members: [], keys: [], index: [] };
	const planned = new Map<string, OrgProfile>();
	const existing = (id: string): ExistingProfile | "unknown" | undefined =>
		existingProfiles instanceof Map ? existingProfiles.get(id) : existingProfiles.has(id) ? "unknown" : undefined;

	for (const row of rows) {
		if (row.org_id) continue;
		const orgId = row.tenant_id;
		const found = existing(orgId);
		const retired = !!found && found !== "unknown" && found.status !== "active";
		const scope = row.scope ?? "write";
		const keyId = row.key_hash.slice(0, 16);
		if (retired) {
			plan.index.push({ key_hash: row.key_hash, org_id: orgId, key_id: keyId, scope, status: "revoked" });
			continue;
		}

		if (!found) {
			const profile = planned.get(orgId);
			if (!profile) {
				planned.set(orgId, {
					org_id: orgId,
					name: row.name,
					status: "active",
					plan: "custom",
					limits: legacyLimits(row.events_per_minute),
					rubric: row.rubric ?? null,
					evals_enabled: true,
					owner_count: owner ? 1 : 0,
					created_at: row.created_at,
					created_by: "operator",
				});
			} else {
				// A tenant's rows share its fields, so this only matters for a half-edited row:
				// keep the earliest creation time and the first rubric found.
				if (row.created_at < profile.created_at) profile.created_at = row.created_at;
				profile.rubric ??= row.rubric ?? null;
			}
		}

		// Every row gets a KEY item, even when its profile exists: the deleter finds an org's
		// key-index rows through its KEY items, so a rewritten row without one would outlive
		// the org.
		const active = row.status === "active";
		plan.keys.push({
			org_id: orgId,
			key_id: keyId,
			name: scope === "read" ? "Legacy read key" : "Legacy key",
			scope,
			prefix: "tw_••••••",
			key_hash: row.key_hash,
			created_by: "operator",
			created_at: row.created_at,
			...(active ? {} : { revoked_at: now }),
		});
		// Anything not plainly active fails closed, so migration can't revive a key.
		plan.index.push({ key_hash: row.key_hash, org_id: orgId, key_id: keyId, scope, status: active ? "active" : "revoked" });
	}

	plan.profiles = [...planned.values()];
	if (owner) {
		const orgIds = plan.profiles.map((p) => p.org_id);
		if (existingProfiles instanceof Map) {
			for (const [id, p] of existingProfiles) if (p.status === "active" && p.owner_count === 0) orgIds.push(id);
		}
		plan.members = orgIds.map((org_id) => ({ org_id, sub: owner.sub, email: normalizeEmail(owner.email), role: "owner", joined_at: now }));
	}
	return plan;
}

type Row = Record<string, unknown>;

async function scanAll(params: ConstructorParameters<typeof ScanCommand>[0]): Promise<Row[]> {
	const items: Row[] = [];
	let startKey: Row | undefined;
	do {
		const page = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey: startKey }));
		items.push(...((page.Items ?? []) as Row[]));
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return items;
}

export async function scanKeyIndex(): Promise<LegacyRow[]> {
	return (await scanAll({ TableName: process.env.TENANTS_TABLE })) as unknown as LegacyRow[];
}

// Deleted orgs are included: their id must not be recreated by a stray old row, and their
// status is how the plan knows to leave their keys alone.
export async function scanProfiles(): Promise<Map<string, ExistingProfile>> {
	const items = await scanAll({
		TableName: process.env.ACCOUNTS_TABLE,
		FilterExpression: "sk = :p",
		ExpressionAttributeValues: { ":p": "PROFILE" },
		ProjectionExpression: "org_id, #n, #s, owner_count",
		ExpressionAttributeNames: { "#n": "name", "#s": "status" },
	});
	return new Map(items.map((i) => [String(i.org_id), { name: String(i.name), status: i.status as OrgStatus, owner_count: Number(i.owner_count ?? 0) }]));
}

export interface MigrationCounts {
	profiles: number;
	members: number;
	keys: number;
	index: number;
	// Index rows of inactive orgs, rewritten as revoked (they get no KEY item).
	retired: number;
	// Rows whose status changed between the scan and the rewrite: left alone, picked up by a re-run.
	stale: number;
}

// A condition that fails means the item is already there (an earlier run wrote it), which is
// the outcome we want, so it is skipped. Throttling and everything else still throws.
const failedCondition = (e: unknown) =>
	e instanceof ConditionalCheckFailedException ||
	(e instanceof TransactionCanceledException && (e.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed"));

async function putOnce(params: ConstructorParameters<typeof PutCommand>[0]): Promise<boolean> {
	try {
		await ddb.send(new PutCommand(params));
		return true;
	} catch (e) {
		if (failedCondition(e)) return false;
		throw e;
	}
}

// Order matters for a crash at any point. An org's profile (with its member and reverse USER
// row, written together as everywhere else) goes first. Then per key: the KEY item, then the
// index rewrite. So a lean index row never exists without its KEY item and profile, and a
// re-run finishes whatever was left: every write is conditional and skips what is done.
export async function applyPlan(plan: MigrationPlan, scan: Scan): Promise<MigrationCounts> {
	const accounts = process.env.ACCOUNTS_TABLE;
	const counts: MigrationCounts = { profiles: 0, members: 0, keys: 0, index: 0, retired: 0, stale: 0 };
	const memberOf = (orgId: string) => plan.members.find((m) => m.org_id === orgId);
	const memberItems = (m: Member, orgName: string) => [
		{ Put: { TableName: accounts, Item: { pk: k.org(m.org_id), sk: k.member(m.sub), ...m }, ConditionExpression: "attribute_not_exists(pk)" } },
		{ Put: { TableName: accounts, Item: { pk: k.user(m.sub), sk: k.org(m.org_id), role: "owner", org_name: orgName } } },
	];

	for (const profile of plan.profiles) {
		const member = memberOf(profile.org_id);
		const items = [
			{ Put: { TableName: accounts, Item: { pk: k.org(profile.org_id), sk: "PROFILE", ...profile }, ConditionExpression: "attribute_not_exists(pk)" } },
			...(member ? memberItems(member, profile.name) : []),
		];
		try {
			await ddb.send(new TransactWriteCommand({ TransactItems: items }));
			counts.profiles++;
			if (member) counts.members++;
		} catch (e) {
			// The profile exists already: leave it, and its owner count, alone.
			if (!failedCondition(e)) throw e;
		}
	}

	// Orgs that already existed with no owner. The count moves in the same transaction, and only
	// from zero on an active org, so two runs (or an owner added meanwhile) can't both succeed.
	const created = new Set(plan.profiles.map((p) => p.org_id));
	for (const member of plan.members) {
		if (created.has(member.org_id)) continue;
		const name = scan.profiles.get(member.org_id)?.name;
		if (name === undefined) throw new Error(`plan attaches an owner to ${member.org_id}, which has no scanned profile`);
		try {
			await ddb.send(
				new TransactWriteCommand({
					TransactItems: [
						...memberItems(member, name),
						{
							Update: {
								TableName: accounts,
								Key: { pk: k.org(member.org_id), sk: "PROFILE" },
								UpdateExpression: "SET owner_count = owner_count + :one",
								ConditionExpression: "owner_count = :zero AND #s = :active",
								ExpressionAttributeNames: { "#s": "status" },
								ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":active": "active" },
							},
						},
					],
				}),
			);
			counts.members++;
		} catch (e) {
			if (!failedCondition(e)) throw e;
		}
	}

	const scanned = new Map(scan.rows.map((r) => [r.key_hash, r.status]));
	const records = new Map(plan.keys.map((r) => [r.key_hash, r]));
	for (const row of plan.index) {
		const scannedStatus = scanned.get(row.key_hash);
		if (scannedStatus === undefined) throw new Error(`plan has no scanned index row for key ${row.key_id}`);
		// A row without a KEY record belongs to an inactive org and is only being retired.
		const record = records.get(row.key_hash);
		if (record) {
			const item = { pk: k.org(record.org_id), sk: k.key(record.key_id), ...record };
			if (await putOnce({ TableName: accounts, Item: item, ConditionExpression: "attribute_not_exists(pk)" })) counts.keys++;
		}
		// Only an old-shape row (no org_id) is replaced, and only while its status is still what
		// the plan was made from: a key revoked since the scan must not come back to life. The
		// lean row has no other fields to lose.
		const written = await putOnce({
			TableName: process.env.TENANTS_TABLE,
			Item: row,
			ConditionExpression: "attribute_not_exists(org_id) AND #s = :scanned",
			ExpressionAttributeNames: { "#s": "status" },
			ExpressionAttributeValues: { ":scanned": scannedStatus },
		});
		if (!written) counts.stale++;
		else if (record) counts.index++;
		else counts.retired++;
	}
	return counts;
}
