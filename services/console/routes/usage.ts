import { json } from "../../shared/http";
import { counterIds, readCounter } from "../../shared/tenants";
import type { RouteTable } from "../handler";
import { listInvites, listKeys, listMembers } from "../store";

export const usageRoutes: RouteTable = {
	"GET /v1/orgs/{orgId}/usage": {
		access: "member",
		run: async (ctx) => {
			const { org_id, limits } = ctx.profile!;
			const now = Date.now();
			// The nightly job samples at night for the day that just ended, so the number to show is yesterday's.
			const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
			const [minute, athena, evals, keys, members, invites] = await Promise.all([
				readCounter(counterIds.minute(org_id, now)),
				readCounter(counterIds.athena(org_id, now)),
				readCounter(counterIds.evals(org_id, yesterday)),
				listKeys(org_id),
				listMembers(org_id),
				listInvites(org_id),
			]);
			return json(200, {
				limits,
				used: {
					events_this_minute: minute,
					// Temporary: Task 2 replaces the daily counter with the period usage.
					events_today: 0,
					analytics_queries_today: athena,
					eval_samples_last_night: evals,
					keys: keys.length,
					members: members.length,
					pending_invites: invites.length,
				},
			});
		},
	},
};
