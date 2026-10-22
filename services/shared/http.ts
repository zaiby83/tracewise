import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyStructuredResultV2 {
	return { statusCode, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

// Structured logs: one JSON object per line, so CloudWatch Logs Insights can query fields.
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
	console[level](JSON.stringify({ level, msg, ...fields }));
}
