import { z } from "zod";
import { json } from "../../shared/http";
import type { RouteTable } from "../handler";
import { createKey, listKeys, revokeKey } from "../store";
import { bodyOf, keyView, limitReached, notFound } from "./common";

const Create = z.object({ name: z.string().trim().min(1).max(100), scope: z.enum(["read", "write"]) });

export const keyRoutes: RouteTable = {
	"GET /v1/orgs/{orgId}/keys": {
		access: "member",
		run: async (ctx) => json(200, { keys: (await listKeys(ctx.profile!.org_id)).map(keyView) }),
	},
	"POST /v1/orgs/{orgId}/keys": {
		access: "member",
		run: async (ctx) => {
			const input = bodyOf(Create, ctx);
			const { org_id, limits } = ctx.profile!;
			if ((await listKeys(org_id)).length >= limits.max_keys) return limitReached("max_keys");
			const { record, secret } = await createKey(org_id, { ...input, created_by: ctx.claims.sub });
			// The secret is returned here and nowhere else.
			return json(201, { key: { ...keyView(record), secret } });
		},
	},
	"DELETE /v1/orgs/{orgId}/keys/{keyId}": {
		access: "member",
		run: async (ctx) => ((await revokeKey(ctx.profile!.org_id, ctx.params.keyId!)) ? json(200, { ok: true }) : notFound()),
	},
};
