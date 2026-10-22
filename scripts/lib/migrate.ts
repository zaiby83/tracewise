import { ConditionalCheckFailedException, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { k, legacyLimits, normalizeEmail, type KeyIndexRow, type KeyRecord, type Member, type OrgProfile } from "../../services/shared/accounts";
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

// Pure: decides what to write and touches nothing, so a re-run is easy to reason about.
// Everything is derived from the rows, and key ids from the key hash, so the same input
// always plans the same items; rows already rewritten (they have an org_id) plan nothing.
export function planMigration(
	rows: LegacyRow[],
	existingProfiles: Set<string>,
	owner?: { sub: string; email: string },
	now = new Date().toISOString(),
): MigrationPlan {
	const plan: MigrationPlan = { profiles: [], members: [], keys: [], index: [] };
	const planned = new Map<string, OrgProfile>();

	for (const row of rows) {
		if (row.org_id) continue;
		const orgId = row.tenant_id;

		if (!existingProfiles.has(orgId)) {
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
		const scope = row.scope ?? "write";
		const keyId = row.key_hash.slice(0, 16);
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
		plan.members = plan.profiles.map((p) => ({ org_id: p.org_id, sub: owner.sub, email: normalizeEmail(owner.email), role: "owner", joined_at: now }));
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

// Deleted orgs count too: their id must not be recreated by a stray old row.
export async function scanProfileIds(): Promise<Set<string>> {
	const items = await scanAll({
		TableName: process.env.ACCOUNTS_TABLE,
		FilterExpression: "sk = :p",
		ExpressionAttributeValues: { ":p": "PROFILE" },
		ProjectionExpression: "org_id",
	});
	return new Set(items.map((i) => String(i.org_id)));
}

export interface MigrationCounts {
	profiles: number;
	members: number;
	keys: number;
	index: number;
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
// re-run finishes whatever was left: both writes are conditional and skip what is done.
export async function applyPlan(plan: MigrationPlan): Promise<MigrationCounts> {
	const accounts = process.env.ACCOUNTS_TABLE;
	const counts: MigrationCounts = { profiles: 0, members: 0, keys: 0, index: 0 };

	for (const profile of plan.profiles) {
		const member = plan.members.find((m) => m.org_id === profile.org_id);
		const items = [
			{ Put: { TableName: accounts, Item: { pk: k.org(profile.org_id), sk: "PROFILE", ...profile }, ConditionExpression: "attribute_not_exists(pk)" } },
			...(member
				? [
						{ Put: { TableName: accounts, Item: { pk: k.org(profile.org_id), sk: k.member(member.sub), ...member }, ConditionExpression: "attribute_not_exists(pk)" } },
						{ Put: { TableName: accounts, Item: { pk: k.user(member.sub), sk: k.org(profile.org_id), role: "owner", org_name: profile.name } } },
					]
				: []),
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

	for (const record of plan.keys) {
		const row = plan.index.find((i) => i.key_hash === record.key_hash);
		if (!row) throw new Error(`plan has no index row for key ${record.key_id}`);
		const item = { pk: k.org(record.org_id), sk: k.key(record.key_id), ...record };
		if (await putOnce({ TableName: accounts, Item: item, ConditionExpression: "attribute_not_exists(pk)" })) counts.keys++;
		// Only an old-shape row (no org_id) is replaced; the lean row has no other fields to lose.
		if (await putOnce({ TableName: process.env.TENANTS_TABLE, Item: row, ConditionExpression: "attribute_not_exists(org_id)" })) counts.index++;
	}
	return counts;
}
