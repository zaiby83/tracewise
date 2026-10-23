import {
	AthenaClient,
	GetQueryExecutionCommand,
	GetQueryResultsCommand,
	StartQueryExecutionCommand,
	type QueryExecution,
} from "@aws-sdk/client-athena";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { json, log } from "../shared/http";
import { jwtClaims, resolveTenant } from "../shared/auth";
import { consumeCounter, counterIds, secondsUntilUtcMidnight } from "../shared/tenants";
import { BY_DAY, BY_ROUTE, MAX_DAYS, parameters, sinceDate, toObjects } from "./queries";

const athena = new AthenaClient({});
const POLL_MS = 300;
// API Gateway's integration limit is 30 s; leave room to respond.
const DEADLINE_MS = 25_000;

// GET /v1/analytics/summary?days=7: cost, latency, errors and security blocks for the
// authenticated tenant (API key or console session), by route and model and by day, from
// the S3/Athena data lake.
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
	const tenant = await resolveTenant(event);
	if (!tenant) return jwtClaims(event) ? json(404, { error: "not found" }) : json(401, { error: "invalid API key" });

	const days = Number(event.queryStringParameters?.days ?? 7);
	if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return json(400, { error: `days must be an integer from 1 to ${MAX_DAYS}` });

	// Athena bills by data scanned, so each org gets a daily number of queries. The row is kept
	// two days so it outlives its UTC day whenever it was created.
	const now = Date.now();
	if (!(await consumeCounter(counterIds.athena(tenant.org_id, now), 1, tenant.limits.analytics_queries_per_day, Math.floor(now / 1000) + 2 * 86_400))) {
		return json(429, { error: "daily analytics query cap reached" }, { "x-tracewise-limit": "analytics", "retry-after": String(secondsUntilUtcMidnight(now)) });
	}

	const params = parameters(tenant.tenant_id, sinceDate(days));
	const started = Date.now();
	try {
		const [byRoute, byDay] = await Promise.all([run(BY_ROUTE, params), run(BY_DAY, params)]);
		const stats = [byRoute.execution, byDay.execution].map((e) => e.Statistics);
		const scanned = stats.reduce((sum, s) => sum + (s?.DataScannedInBytes ?? 0), 0);
		log("info", "analytics query", { tenant_id: tenant.tenant_id, days, scanned_bytes: scanned, ms: Date.now() - started });
		return json(200, {
			days,
			since: params[1]!.replaceAll("'", ""),
			byRoute: byRoute.rows,
			byDay: byDay.rows,
			query: {
				ms: Date.now() - started,
				scannedBytes: scanned,
				reusedCachedResult: stats.every((s) => s?.ResultReuseInformation?.ReusedPreviousResult),
			},
		});
	} catch (err) {
		if (err instanceof QueryTimeout) return json(504, { error: "query is taking too long, retry shortly" });
		log("error", "analytics query failed", { tenant_id: tenant.tenant_id, error: String(err) });
		return json(500, { error: "analytics query failed" });
	}
}

class QueryTimeout extends Error {}

async function run(sql: string, params: string[]): Promise<{ rows: ReturnType<typeof toObjects>; execution: QueryExecution }> {
	const { QueryExecutionId } = await athena.send(
		new StartQueryExecutionCommand({
			QueryString: sql,
			WorkGroup: process.env.WORKGROUP,
			QueryExecutionContext: { Database: process.env.GLUE_DATABASE },
			ExecutionParameters: params,
			// Identical questions within 5 minutes reuse the stored result: no scan, no charge.
			ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: true, MaxAgeInMinutes: 5 } },
		}),
	);

	const deadline = Date.now() + DEADLINE_MS;
	for (;;) {
		const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
		const state = QueryExecution?.Status?.State;
		if (state === "SUCCEEDED") {
			const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
			return { rows: toObjects(results.ResultSet?.Rows ?? []), execution: QueryExecution! };
		}
		if (state === "FAILED" || state === "CANCELLED") {
			throw new Error(`query ${state}: ${QueryExecution?.Status?.StateChangeReason ?? "unknown reason"}`);
		}
		if (Date.now() > deadline) throw new QueryTimeout();
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}
