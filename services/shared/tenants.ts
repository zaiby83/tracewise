import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { periodBounds, planFields, retentionFor } from "../billing/plans";
import { getProfile, legacyLimits, type Limits } from "./accounts";
import { ddb } from "./ddb";
import { log } from "./http";
import { hashApiKey } from "./keys";

export interface Tenant {
	// Equal to org_id: the rest of the pipeline keys its data by tenant_id.
	tenant_id: string;
	org_id: string;
	// Absent for tenants that predate self-serve keys.
	key_id?: string;
	name: string;
	status: "active";
	// "read" keys can query but not ingest, so one can be embedded in a public dashboard.
	// Keys created before scopes existed have none and are treated as "write".
	scope?: "read" | "write";
	plan: string;
	limits: Limits;
	// Hot-retention days, stamped on each queued event so the processor needn't read the profile.
	retention_days: number;
	// ISO dates bounding the billing period the monthly counter belongs to.
	period_start: string;
	period_end: string;
	rubric: string | null;
	evals_enabled: boolean;
}

export const canWrite = (t: Tenant) => (t.scope ?? "write") === "write";

// Re-exported so existing imports (and test mocks of this module) keep working.
export { ddb } from "./ddb";

// Tenant lookups are cached per Lambda instance for a minute: every ingest request
// authenticates, and the key and profile rows change rarely. Revoking a key or suspending
// an org therefore takes up to a minute to apply everywhere, a deliberate trade for fewer
// reads per request.
const CACHE_MS = 60_000;
const cache = new Map<string, { tenant: Tenant | null; until: number }>();

export async function tenantForKey(apiKey: string): Promise<Tenant | null> {
	const keyHash = hashApiKey(apiKey);
	const hit = cache.get(keyHash);
	if (hit && hit.until > Date.now()) return hit.tenant;

	const tenant = await resolve(keyHash);
	cache.set(keyHash, { tenant, until: Date.now() + CACHE_MS });
	return tenant;
}

// The Tenants table is the key index: one get by key hash. New rows point at an org, whose
// profile carries the name and limits. Rows from before self-serve have no org_id and carry
// their own fields, so they keep working until the migration rewrites them, unless their org
// has a profile that isn't active: a deleted or suspended org must not keep ingesting through
// a key the migration hasn't reached.
async function resolve(keyHash: string): Promise<Tenant | null> {
	const { Item } = await ddb.send(new GetCommand({ TableName: process.env.TENANTS_TABLE, Key: { key_hash: keyHash } }));
	if (!Item || Item.status !== "active") return null;

	if (!Item.org_id) {
		const legacy = await getProfile(Item.tenant_id);
		if (legacy && legacy.status !== "active") return null;
		const period = periodBounds({ plan: "custom" });
		return {
			tenant_id: Item.tenant_id,
			org_id: Item.tenant_id,
			name: Item.name,
			status: "active",
			scope: Item.scope,
			// Legacy tenants keep their old behaviour: uncapped, 30 days, calendar-month counter.
			plan: "custom",
			limits: legacyLimits(Item.events_per_minute),
			retention_days: retentionFor({ plan: "custom" }),
			period_start: period.start,
			period_end: period.end,
			rubric: null,
			evals_enabled: true,
		};
	}

	const profile = await getProfile(Item.org_id);
	if (!profile || profile.status !== "active") return null;
	return {
		tenant_id: profile.org_id,
		org_id: profile.org_id,
		key_id: Item.key_id,
		name: profile.name,
		status: "active",
		scope: Item.scope,
		...planFields(profile),
		rubric: profile.rubric,
		evals_enabled: profile.evals_enabled,
	};
}

// Counters live in the Quotas table, one row per id, and are incremented atomically so the
// limits hold across every concurrent Lambda instance. Returns false when adding n would
// take the counter past max.
export async function consumeCounter(id: string, n: number, max: number, expiresAt: number): Promise<boolean> {
	if (n > max) return false;
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.QUOTAS_TABLE,
				Key: { window: id },
				UpdateExpression: "ADD used :n SET expires_at = if_not_exists(expires_at, :exp)",
				ConditionExpression: "attribute_not_exists(used) OR used <= :max",
				ExpressionAttributeValues: { ":n": n, ":max": max - n, ":exp": expiresAt },
			}),
		);
		return true;
	} catch (err) {
		if (err instanceof ConditionalCheckFailedException) return false;
		throw err;
	}
}

export async function readCounter(id: string): Promise<number> {
	const { Item } = await ddb.send(new GetCommand({ TableName: process.env.QUOTAS_TABLE, Key: { window: id } }));
	return Number(Item?.used ?? 0);
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export const counterIds = {
	// Fixed one-minute windows.
	minute: (org: string, now: number) => `${org}#${Math.floor(now / 60_000)}`,
	// Keyed by the period start so a new billing period starts a fresh counter.
	period: (org: string, periodStart: string) => `${org}#month#${periodStart}`,
	athena: (org: string, now: number) => `${org}#athena#${utcDay(now)}`,
	// Takes the day itself because the nightly job counts the night it started on.
	evals: (org: string, day: string) => `${org}#evals#${day}`,
	globalOrgs: (now: number) => `global#orgs#${utcDay(now)}`,
};

export type QuotaResult = "ok" | "minute" | "month" | "spend_cap";

const FORTY_DAYS_S = 40 * 86_400;

// Checks the per-minute rate, then the per-period total, and says which one refused so the
// caller can tell the client when to retry. The period counter is incremented for uncapped
// plans too (against a huge max): the hourly meter reads it to bill overage.
export async function consumeQuota(tenant: Tenant, events: number, now = Date.now()): Promise<QuotaResult> {
	const minute = Math.floor(now / 60_000);
	if (!(await consumeCounter(counterIds.minute(tenant.org_id, now), events, tenant.limits.events_per_minute, (minute + 2) * 60))) return "minute";

	// Kept 40 days past the period end so the meter can still read it after a late webhook.
	const expiresAt = Math.floor(Date.parse(tenant.period_end) / 1000) + FORTY_DAYS_S;
	const max = tenant.limits.monthly_events ?? Number.MAX_SAFE_INTEGER;
	if (!(await consumeCounter(counterIds.period(tenant.org_id, tenant.period_start), events, max, expiresAt))) {
		// Free orgs hit their allowance; paid orgs hit the spend cap they chose.
		return tenant.plan === "free" ? "month" : "spend_cap";
	}
	return "ok";
}

// Gives counted events back when the enqueue fails, so a client's retry isn't charged twice.
// Best effort: a failure here only overcounts, and must not mask the 503 the caller returns.
export async function releaseQuota(tenant: Tenant, events: number): Promise<void> {
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.QUOTAS_TABLE,
				Key: { window: counterIds.period(tenant.org_id, tenant.period_start) },
				UpdateExpression: "ADD used :neg",
				ExpressionAttributeValues: { ":neg": -events },
			}),
		);
	} catch (err) {
		log("error", "release quota failed", { tenant_id: tenant.tenant_id, events, error: err instanceof Error ? err.message : String(err) });
	}
}

export const secondsUntil = (isoDate: string, now = Date.now()): number => Math.max(0, Math.ceil((Date.parse(isoDate) - now) / 1000));

export const secondsUntilUtcMidnight = (now = Date.now()): number => 86_400 - Math.floor((now % 86_400_000) / 1000);
