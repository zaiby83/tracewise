import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { planFields } from "../billing/plans";
import { getMember, getProfile, normalizeEmail, touchKey } from "./accounts";
import { bearerToken } from "./keys";
import { tenantForKey, type Tenant } from "./tenants";

export interface Claims {
	sub: string;
	email: string;
	email_verified: boolean;
}

// The JWT authorizer of an HTTP API verifies the token before the Lambda runs and puts its
// claims on the event, so handlers only read them. Its claim values can arrive as strings
// ("true"), and API key requests, which carry no authorizer, have none at all.
export function jwtClaims(event: APIGatewayProxyEventV2): Claims | null {
	const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } | undefined)?.authorizer?.jwt?.claims;
	if (!claims || typeof claims.sub !== "string" || !claims.sub) return null;
	return {
		sub: claims.sub,
		email: typeof claims.email === "string" ? normalizeEmail(claims.email) : "",
		email_verified: claims.email_verified === true || claims.email_verified === "true",
	};
}

// A signed-in console user reads an org they belong to, named in the path. A request that
// carries claims never falls back to an API key: it is a session or nothing.
export async function resolveTenant(event: APIGatewayProxyEventV2): Promise<Tenant | null> {
	const claims = jwtClaims(event);
	if (claims) return tenantForMember(event.pathParameters?.orgId, claims.sub);

	const key = bearerToken(event.headers.authorization);
	const tenant = key ? await tenantForKey(key) : null;
	if (tenant?.key_id) touchKey(tenant.org_id, tenant.key_id);
	return tenant;
}

async function tenantForMember(orgId: string | undefined, sub: string): Promise<Tenant | null> {
	if (!orgId) return null;
	const member = await getMember(orgId, sub);
	if (!member) return null;
	const profile = await getProfile(orgId);
	if (!profile || profile.status !== "active") return null;
	return {
		tenant_id: profile.org_id,
		org_id: profile.org_id,
		name: profile.name,
		status: "active",
		// Members can read an org's data; changing it goes through the console routes.
		scope: "read",
		...planFields(profile),
		rubric: profile.rubric,
		evals_enabled: profile.evals_enabled,
	};
}
