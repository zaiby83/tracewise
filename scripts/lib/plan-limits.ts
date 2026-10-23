import { PLANS } from "../../services/billing/plans";
import type { OrgProfile } from "../../services/shared/accounts";

const sameLimits = (a: OrgProfile["limits"], b: OrgProfile["limits"]) =>
	(Object.keys(b) as (keyof typeof b)[]).every((key) => a[key] === b[key]) && Object.keys(a).length === Object.keys(b).length;

// The PROFILE changes that move a free org onto the Free plan's current limits and 7-day
// retention, or null when there is nothing to change. Custom orgs keep their hand-set limits and
// 30 days; paid orgs are driven by their subscription; an org that isn't active is left alone.
export function planFreeUpgrade(profile: OrgProfile): Partial<OrgProfile> | null {
	if (profile.plan !== "free" || profile.status !== "active") return null;
	if (sameLimits(profile.limits, PLANS.free.limits) && profile.retention_days === PLANS.free.retention_days) return null;
	// A copy, because PLANS.free.limits is frozen and the caller writes this to DynamoDB.
	return { limits: { ...PLANS.free.limits }, retention_days: PLANS.free.retention_days };
}
