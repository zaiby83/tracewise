import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { z } from "zod";
import type { Invite, KeyRecord, Member, OrgProfile } from "../../shared/accounts";
import { DEFAULT_RUBRIC } from "../../evals/judge-prompt";
import { json } from "../../shared/http";
import type { Ctx } from "../handler";

// Thrown by bodyOf and caught by the handler, which answers 400 with the issues.
export class BadRequest extends Error {
	constructor(message: string, readonly issues: { path: string; message: string }[] = []) {
		super(message);
	}
}

// Validates the request body. Routes pass the parsed result on and never the raw body, so a
// client can't smuggle extra fields into a store write.
export function bodyOf<S extends z.ZodType>(schema: S, ctx: Ctx): z.infer<S> {
	const parsed = schema.safeParse(ctx.body);
	if (parsed.success) return parsed.data;
	throw new BadRequest("invalid request", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

export const notFound = (): APIGatewayProxyStructuredResultV2 => json(404, { error: "not found" });
export const limitReached = (limit: string): APIGatewayProxyStructuredResultV2 => json(409, { error: "limit reached", limit });

// The handler is the safety boundary for responses. Records come straight from DynamoDB
// (with table keys, and for keys and invites the hashes that authenticate them), so
// everything returned goes through one of these projections.
export const orgView = (profile: OrgProfile, role: Member["role"]) => {
	const { pk: _pk, sk: _sk, ...rest } = profile as OrgProfile & { pk?: string; sk?: string };
	return { ...rest, role, default_rubric: DEFAULT_RUBRIC };
};

export const keyView = (k: KeyRecord) => ({
	key_id: k.key_id,
	name: k.name,
	scope: k.scope,
	prefix: k.prefix,
	created_by: k.created_by,
	created_at: k.created_at,
	last_used_at: k.last_used_at ?? null,
});

export const memberView = (m: Member) => ({ sub: m.sub, email: m.email, role: m.role, joined_at: m.joined_at });

export const inviteView = (i: Invite) => ({ invite_id: i.invite_id, email: i.email, role: i.role, expires_at: i.expires_at });
