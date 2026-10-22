// SQL for the analytics API. No client input ever reaches the SQL text: the tenant
// comes from the authenticated API key, the start date is computed server-side from a
// validated integer, and both are passed to Athena as execution parameters.
//
// `tenant_id = ?` is also what makes the query cheap and isolated: the table uses
// injected partition projection on tenant_id, so Athena reads only that tenant's
// S3 prefix and refuses queries that don't name one.
//
// Firehose delivery is at-least-once, so a retried batch can repeat an event. Call
// counts use approx_distinct(event_id); sums can overcount by the (rare) duplicates.

export const MAX_DAYS = 90;

export function sinceDate(days: number, now = new Date()): string {
	const d = new Date(now);
	d.setUTCDate(d.getUTCDate() - (days - 1));
	return d.toISOString().slice(0, 10);
}

export const BY_ROUTE = `
SELECT
	coalesce(route, '(none)') AS route,
	model,
	approx_distinct(event_id) AS calls,
	approx_percentile(latency_ms, 0.5) AS p50_ms,
	approx_percentile(latency_ms, 0.95) AS p95_ms,
	sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) AS tokens,
	round(sum(coalesce(cost_usd, 0)), 6) AS cost_usd,
	round(avg(CASE WHEN status = 'error' THEN 1.0 ELSE 0.0 END), 4) AS error_rate,
	count_if(security.verdict = 'blocked') AS blocked
FROM traces
WHERE tenant_id = ? AND dt >= ?
GROUP BY 1, 2
ORDER BY calls DESC
LIMIT 50`;

export const BY_DAY = `
SELECT
	dt AS day,
	approx_distinct(event_id) AS calls,
	approx_percentile(latency_ms, 0.95) AS p95_ms,
	round(sum(coalesce(cost_usd, 0)), 6) AS cost_usd,
	count_if(status = 'error') AS errors,
	count_if(security.verdict = 'blocked') AS blocked
FROM traces
WHERE tenant_id = ? AND dt >= ?
GROUP BY 1
ORDER BY 1`;

// Athena execution parameters are SQL literals, so strings carry their own quotes.
// Both values are server-generated, and this check guarantees they stay inert.
export function parameters(tenantId: string, since: string): string[] {
	if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error("unexpected tenant id format");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("unexpected date format");
	return [`'${tenantId}'`, `'${since}'`];
}

type Cell = { VarCharValue?: string };

// Athena returns every value as a string, with the header as the first row. Convert
// numeric-looking columns back to numbers.
export function toObjects(rows: { Data?: Cell[] }[]): Record<string, string | number | null>[] {
	const [header, ...body] = rows;
	const names = (header?.Data ?? []).map((c) => c.VarCharValue ?? "");
	return body.map((row) =>
		Object.fromEntries(
			names.map((name, i) => {
				const raw = row.Data?.[i]?.VarCharValue;
				if (raw === undefined) return [name, null];
				return [name, /^-?\d+(\.\d+)?(E-?\d+)?$/i.test(raw) && name !== "day" ? Number(raw) : raw];
			}),
		),
	);
}
