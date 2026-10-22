// Creates a tenant and prints its API key once. Only the key's hash is stored.
// Usage: pnpm tenant:create "<tenant name>" [eventsPerMinute]
import { randomUUID } from "node:crypto";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { hashApiKey, newApiKey } from "../services/shared/keys";
import { ddb } from "../services/shared/tenants";

const [name, perMinute = "6000"] = process.argv.slice(2);
if (!name) {
	console.error('usage: pnpm tenant:create "<tenant name>" [eventsPerMinute]');
	process.exit(1);
}

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "Tracewise" }));
const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
if (!outputs.TenantsTable) throw new Error("Tracewise stack not found: deploy it first");

const apiKey = newApiKey();
const tenant = { key_hash: hashApiKey(apiKey), tenant_id: randomUUID(), name, status: "active", events_per_minute: Number(perMinute), created_at: new Date().toISOString() };
await ddb.send(new PutCommand({ TableName: outputs.TenantsTable, Item: tenant, ConditionExpression: "attribute_not_exists(key_hash)" }));

console.error(`Created tenant "${name}" (${tenant.tenant_id}), ${perMinute} events/min.`);
console.error("API key (shown once, store it somewhere safe):");
console.log(apiKey);
console.error(`Ingest endpoint: ${outputs.ApiUrl}/v1/traces`);
