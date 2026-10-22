import { z } from "zod";
import { json } from "../../shared/http";
import type { RouteTable } from "../handler";
import { acceptInvite, createInvite, listInvites, listMembers, removeMember, revokeInvite, setRole } from "../store";
import { bodyOf, inviteView, limitReached, memberView, notFound } from "./common";

const Role = z.enum(["owner", "member"]);
const SetRole = z.object({ role: Role });
const Invite = z.object({ email: z.email(), role: Role });
const Accept = z.object({ token: z.string().min(1).max(512) });

// Both membership changes end the same ways.
const membership = (result: "ok" | "last_owner" | "not_found", ok: Record<string, unknown>) =>
	result === "ok" ? json(200, ok) : result === "last_owner" ? json(409, { error: "an organisation needs at least one owner" }) : notFound();

export const teamRoutes: RouteTable = {
	"GET /v1/orgs/{orgId}/members": {
		access: "member",
		run: async (ctx) => json(200, { members: (await listMembers(ctx.profile!.org_id)).map(memberView) }),
	},
	"PATCH /v1/orgs/{orgId}/members/{sub}": {
		access: "owner",
		run: async (ctx) => {
			const { role } = bodyOf(SetRole, ctx);
			const sub = ctx.params.sub!;
			return membership(await setRole(ctx.profile!.org_id, sub, role), { sub, role });
		},
	},
	"DELETE /v1/orgs/{orgId}/members/{sub}": {
		access: "self-or-owner",
		run: async (ctx) => membership(await removeMember(ctx.profile!.org_id, ctx.params.sub!), { ok: true }),
	},
	"GET /v1/orgs/{orgId}/invites": {
		access: "owner",
		run: async (ctx) => json(200, { invites: (await listInvites(ctx.profile!.org_id)).map(inviteView) }),
	},
	"POST /v1/orgs/{orgId}/invites": {
		access: "owner",
		run: async (ctx) => {
			const input = bodyOf(Invite, ctx);
			const { org_id, limits } = ctx.profile!;
			const [members, pending] = await Promise.all([listMembers(org_id), listInvites(org_id)]);
			if (pending.length >= limits.max_pending_invites) return limitReached("max_pending_invites");
			// A pending invite is a seat that will be taken, so it counts against the member cap.
			if (members.length + pending.length >= limits.max_members) return limitReached("max_members");
			const { invite, link } = await createInvite(org_id, { ...input, created_by: ctx.claims.sub });
			// The link carries the token, which is returned here and nowhere else.
			return json(201, { invite_id: invite.invite_id, link, expires_at: invite.expires_at });
		},
	},
	"DELETE /v1/orgs/{orgId}/invites/{inviteId}": {
		access: "owner",
		run: async (ctx) => ((await revokeInvite(ctx.profile!.org_id, ctx.params.inviteId!)) ? json(200, { ok: true }) : notFound()),
	},
	"POST /v1/invites/accept": {
		access: "user",
		run: async (ctx) => {
			const { token } = bodyOf(Accept, ctx);
			const joined = await acceptInvite(token, ctx.claims);
			// Wrong, expired, used, someone else's: all the same answer.
			return joined ? json(200, { org_id: joined.org_id }) : notFound();
		},
	},
};
