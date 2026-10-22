import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { getMember, getProfile, type Member, type OrgProfile } from "../shared/accounts";
import { jwtClaims, type Claims } from "../shared/auth";
import { json, log } from "../shared/http";
import { CONSOLE_ROUTES } from "./route-keys";
import { BadRequest } from "./routes/common";
import { keyRoutes } from "./routes/keys";
import { orgRoutes } from "./routes/orgs";
import { teamRoutes } from "./routes/team";
import { usageRoutes } from "./routes/usage";

// How much of an org a route needs: just a signed-in user, a member of the org named in the
// path, an owner of it, or an owner or the member the path itself names.
export type Access = "user" | "member" | "owner" | "self-or-owner";

export interface Ctx {
	claims: Claims;
	params: Record<string, string>;
	// Parsed JSON, or undefined when the request had no body. Routes validate it with zod.
	body: unknown;
	// Loaded for every route that needs membership.
	member?: Member;
	profile?: OrgProfile;
}

export interface Route {
	access: Access;
	// The signed-in account's email must be verified.
	verified?: boolean;
	run(ctx: Ctx): Promise<APIGatewayProxyStructuredResultV2>;
}

export type RouteTable = Record<string, Route>;

const routes: RouteTable = { ...orgRoutes, ...keyRoutes, ...teamRoutes, ...usageRoutes };

// The stack wires CONSOLE_ROUTES to this Lambda, so a route missing here (or served here
// but never wired) is a deploy-time mistake: fail at load rather than 404 in production.
{
	const have = Object.keys(routes).sort().join("\n");
	const want = [...CONSOLE_ROUTES].sort().join("\n");
	if (have !== want) throw new Error("console routes do not match CONSOLE_ROUTES");
}

const notFound = () => json(404, { error: "not found" });

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): unknown {
	if (!event.body) return undefined;
	const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
	try {
		return JSON.parse(text);
	} catch {
		throw new BadRequest("invalid JSON");
	}
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
	const route = Object.hasOwn(routes, event.routeKey) ? routes[event.routeKey] : undefined;
	if (!route) return notFound();
	const claims = jwtClaims(event);
	if (!claims) return json(401, { error: "unauthorized" });

	const params = (event.pathParameters ?? {}) as Record<string, string>;
	try {
		const ctx: Ctx = { claims, params, body: undefined };
		if (route.access !== "user") {
			// Not cached: a removed member loses access on their next request. A missing member,
			// a missing org and one being deleted all look the same, so the API never confirms
			// that an org exists.
			const orgId = params.orgId;
			const [member, profile] = orgId ? await Promise.all([getMember(orgId, claims.sub), getProfile(orgId)]) : [null, null];
			if (!member || !profile || profile.status !== "active") return notFound();
			ctx.member = member;
			ctx.profile = profile;
			const isOwner = member.role === "owner";
			if (route.access === "owner" && !isOwner) return json(403, { error: "owner only" });
			if (route.access === "self-or-owner" && !isOwner && params.sub !== claims.sub) return json(403, { error: "owner only" });
		}
		if (route.verified && !claims.email_verified) return json(403, { error: "verify your email first" });
		ctx.body = parseBody(event);
		return await route.run(ctx);
	} catch (e) {
		if (e instanceof BadRequest) return json(400, { error: e.message, issues: e.issues });
		// Route, org and caller only: bodies, key secrets and invite tokens never reach the logs.
		log("error", "console request failed", {
			route: event.routeKey,
			org_id: params.orgId,
			sub: claims.sub,
			error: e instanceof Error ? e.message : String(e),
		});
		return json(500, { error: "internal error" });
	}
}
