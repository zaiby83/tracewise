import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { hashApiKey } from "./keys";

export interface Tenant {
	tenant_id: string;
	name: string;
	status: "active" | "disabled";
	events_per_minute: number;
	// "read" keys can query but not ingest, so one can be embedded in a public dashboard.
	// Keys created before scopes existed have none and are treated as "write".
	scope?: "read" | "write";
}

export const canWrite = (t: Tenant) => (t.scope ?? "write") === "write";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
	marshallOptions: { removeUndefinedValues: true },
});

// Tenant lookups are cached per Lambda instance for a minute: every ingest request
// authenticates, and the tenant record changes rarely. Disabling a key therefore takes
// up to a minute to apply everywhere, a deliberate trade for one less read per request.
const CACHE_MS = 60_000;
const cache = new Map<string, { tenant: Tenant | null; until: number }>();

export async function tenantForKey(apiKey: string): Promise<Tenant | null> {
	const keyHash = hashApiKey(apiKey);
	const hit = cache.get(keyHash);
	if (hit && hit.until > Date.now()) return hit.tenant;

	const { Item } = await ddb.send(new GetCommand({ TableName: process.env.TENANTS_TABLE, Key: { key_hash: keyHash } }));
	const tenant = Item && Item.status === "active" ? (Item as Tenant) : null;
	cache.set(keyHash, { tenant, until: Date.now() + CACHE_MS });
	return tenant;
}

// Fixed one-minute windows, counted atomically in DynamoDB so the quota holds across
// every concurrent Lambda instance. Returns false when the request would exceed it.
export async function consumeQuota(tenant: Tenant, events: number, now = Date.now()): Promise<boolean> {
	const minute = Math.floor(now / 60_000);
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.QUOTAS_TABLE,
				Key: { window: `${tenant.tenant_id}#${minute}` },
				UpdateExpression: "ADD used :n SET expires_at = if_not_exists(expires_at, :exp)",
				ConditionExpression: "attribute_not_exists(used) OR used <= :max",
				ExpressionAttributeValues: { ":n": events, ":max": tenant.events_per_minute - events, ":exp": (minute + 2) * 60 },
			}),
		);
		return true;
	} catch (err) {
		if (err instanceof ConditionalCheckFailedException) return false;
		throw err;
	}
}
