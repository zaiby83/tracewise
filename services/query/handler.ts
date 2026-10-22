import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json } from "../shared/http";
import { bearerToken, partitionsForDay } from "../shared/keys";
import { ddb, tenantForKey } from "../shared/tenants";

const MAX_LIMIT = 200;

// GET /v1/traces?day=YYYY-MM-DD&limit=50. Returns a tenant's most recent traces for a
// day. A day's traces are spread over shards, so this queries every shard in
// parallel and merges the newest. The tenant comes from the API key, never from the
// request, so one tenant can't read another's data.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	const key = bearerToken(event.headers.authorization);
	const tenant = key ? await tenantForKey(key) : null;
	if (!tenant) return json(401, { error: "invalid API key" });

	const day = event.queryStringParameters?.day ?? new Date().toISOString().slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { error: "day must be YYYY-MM-DD" });
	const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit ?? 50) || 50, 1), MAX_LIMIT);

	const pages = await Promise.all(
		partitionsForDay(tenant.tenant_id, day).map((pk) =>
			ddb.send(
				new QueryCommand({
					TableName: process.env.TRACES_TABLE,
					KeyConditionExpression: "pk = :pk",
					ExpressionAttributeValues: { ":pk": pk },
					ScanIndexForward: false,
					Limit: limit,
				}),
			),
		),
	);
	const traces = pages
		.flatMap((p) => p.Items ?? [])
		.sort((a, b) => String(b.sk).localeCompare(String(a.sk)))
		.slice(0, limit)
		.map(({ pk, sk, expires_at, tenant_id, ...trace }) => trace);

	return json(200, { day, count: traces.length, traces });
}
