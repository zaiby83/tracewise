// Adds another API key to an existing tenant, e.g. a read-only key for a dashboard.
// Usage: pnpm exec tsx scripts/create-key.ts "<tenant name>" [read|write]
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { hashApiKey, newApiKey } from "../services/shared/keys";
import { ddb } from "../services/shared/tenants";

const [name, scope = "read"] = process.argv.slice(2);
if (!name || !["read", "write"].includes(scope)) {
	console.error('usage: pnpm exec tsx scripts/create-key.ts "<tenant name>" [read|write]');
	process.exit(1);
}

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "Tracewise" }));
const table = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "TenantsTable")?.OutputValue;
if (!table) throw new Error("Tracewise stack not found: deploy it first");

const { Items = [] } = await ddb.send(new ScanCommand({ TableName: table, FilterExpression: "#n = :n", ExpressionAttributeNames: { "#n": "name" }, ExpressionAttributeValues: { ":n": name } }));
const existing = Items[0];
if (!existing) throw new Error(`no tenant named "${name}"`);

const apiKey = newApiKey();
await ddb.send(
	new PutCommand({
		TableName: table,
		Item: { ...existing, key_hash: hashApiKey(apiKey), scope, created_at: new Date().toISOString() },
		ConditionExpression: "attribute_not_exists(key_hash)",
	}),
);
console.error(`Added a ${scope} key to "${name}" (${existing.tenant_id}). Shown once:`);
console.log(apiKey);
