import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json } from "../shared/http";
import { jwtClaims, resolveTenant } from "../shared/auth";
import { partitionsForDay } from "../shared/keys";
import { ddb } from "../shared/tenants";

const MAX_LIMIT = 200;

// GET /v1/traces?day=YYYY-MM-DD&limit=50. Returns a tenant's most recent traces for a
// day. A day's traces are spread over shards, so this queries every shard in
// parallel and merges the newest. The tenant comes from the API key, or from the org the
// signed-in user is a member of, never from the request body, so one tenant can't read
// another's data.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	const tenant = await resolveTenant(event);
	if (!tenant) return jwtClaims(event) ? json(404, { error: "not found" }) : json(401, { error: "invalid API key" });

	// GET /v1/me: who this key belongs to, for the dashboard header. Keys only.
	if (event.rawPath === "/v1/me") return jwtClaims(event) ? json(404, { error: "not found" }) : json(200, { name: tenant.name, scope: tenant.scope ?? "write" });

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
