// The console API's routes, defined once so the CDK stack (which wires them to the console
// Lambda) and the handler's router can't drift apart.
export const CONSOLE_ROUTES = [
	"GET /v1/orgs",
	"POST /v1/orgs",
	"GET /v1/orgs/{orgId}",
	"PATCH /v1/orgs/{orgId}",
	"DELETE /v1/orgs/{orgId}",
	"GET /v1/orgs/{orgId}/keys",
	"POST /v1/orgs/{orgId}/keys",
	"DELETE /v1/orgs/{orgId}/keys/{keyId}",
	"GET /v1/orgs/{orgId}/members",
	"PATCH /v1/orgs/{orgId}/members/{sub}",
	"DELETE /v1/orgs/{orgId}/members/{sub}",
	"GET /v1/orgs/{orgId}/invites",
	"POST /v1/orgs/{orgId}/invites",
	"DELETE /v1/orgs/{orgId}/invites/{inviteId}",
	"POST /v1/invites/accept",
	"GET /v1/orgs/{orgId}/usage",
	"GET /v1/orgs/{orgId}/billing",
	"POST /v1/orgs/{orgId}/billing/checkout",
	"POST /v1/orgs/{orgId}/billing/portal",
	"POST /v1/orgs/{orgId}/billing/change",
	"PATCH /v1/orgs/{orgId}/billing",
] as const satisfies readonly string[];

// Existing data routes that also accept a console session (JWT) next to an API key.
export const JWT_DATA_ROUTES = {
	query: "GET /v1/orgs/{orgId}/traces",
	summary: "GET /v1/orgs/{orgId}/analytics/summary",
	evalsApi: "GET /v1/orgs/{orgId}/evals",
} as const;

export function splitRouteKey(key: string): { method: string; path: string } {
	const [method = "", path = ""] = key.split(" ");
	return { method, path };
}
