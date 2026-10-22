import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json } from "../shared/http";
import { bearerToken } from "../shared/keys";
import { ddb, tenantForKey } from "../shared/tenants";

// GET /v1/evals?limit=10: the tenant's most recent evaluation runs, newest first.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	const key = bearerToken(event.headers.authorization);
	const tenant = key ? await tenantForKey(key) : null;
	if (!tenant) return json(401, { error: "invalid API key" });

	const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 10) || 10, 1), 50);
	const { Items } = await ddb.send(
		new QueryCommand({
			TableName: process.env.EVALS_TABLE,
			KeyConditionExpression: "tenant_id = :t",
			ExpressionAttributeValues: { ":t": tenant.tenant_id },
			ScanIndexForward: false,
			Limit: limit,
		}),
	);
	return json(200, { runs: (Items ?? []).map(({ tenant_id, expires_at, ...run }) => run) });
}
