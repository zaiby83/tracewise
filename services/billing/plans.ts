import type { Limits } from "../shared/accounts";

export type PlanId = "free" | "team" | "pro";

export interface Plan {
	id: PlanId;
	name: string;
	price_usd: number;
	limits: Limits;
	retention_days: number;
	included_events: number;
	overage_per_100k_usd: number | null;
	// Stripe price lookup keys; free has no Stripe objects.
	stripe: { base: string; metered: string } | null;
}

// `monthly_events` is the plan's own cap: the included allowance on free (a hard cap), and
// null on paid plans, where overage is billed unless the org sets a spend cap.
const PLAN_TABLE: Record<PlanId, Plan> = {
	free: {
		id: "free",
		name: "Free",
		price_usd: 0,
		limits: { events_per_minute: 600, monthly_events: 50_000, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 3, max_members: 2, max_pending_invites: 2 },
		retention_days: 7,
		included_events: 50_000,
		overage_per_100k_usd: null,
		stripe: null,
	},
	team: {
		id: "team",
		name: "Team",
		price_usd: 29,
		limits: { events_per_minute: 6_000, monthly_events: null, eval_samples_per_night: 100, analytics_queries_per_day: 2_000, max_keys: 20, max_members: 10, max_pending_invites: 10 },
		retention_days: 30,
		included_events: 500_000,
		overage_per_100k_usd: 5,
		stripe: { base: "team_monthly", metered: "team_metered" },
	},
	pro: {
		id: "pro",
		name: "Pro",
		price_usd: 199,
		limits: { events_per_minute: 30_000, monthly_events: null, eval_samples_per_night: 500, analytics_queries_per_day: 10_000, max_keys: 100, max_members: 50, max_pending_invites: 50 },
		retention_days: 90,
		included_events: 5_000_000,
		overage_per_100k_usd: 3,
		stripe: { base: "pro_monthly", metered: "pro_metered" },
	},
};

// Frozen, including each limits and stripe object: FREE_LIMITS shares a reference with
// PLANS.free.limits, so a stray mutation would silently change every free org's cap.
export const PLANS: Record<PlanId, Plan> = Object.freeze(
	Object.fromEntries(
		Object.entries(PLAN_TABLE).map(([id, plan]) => [id, Object.freeze({ ...plan, limits: Object.freeze(plan.limits), stripe: plan.stripe && Object.freeze(plan.stripe) })]),
	) as Record<PlanId, Plan>,
);

// The per-period event ceiling ingest enforces. A paid org's spend cap becomes extra events
// at the plan's overage rate; custom orgs are never capped here.
export function deriveMonthlyEvents(plan: Plan | "custom", spendCapUsd: number | null): number | null {
	if (plan === "custom") return null;
	if (plan.overage_per_100k_usd === null) return plan.included_events;
	if (spendCapUsd === null) return null;
	// Whole cents keep fractional caps (0.29 USD) free of float error.
	return plan.included_events + Math.floor((Math.round(spendCapUsd * 100) * 100_000) / Math.round(plan.overage_per_100k_usd * 100));
}

export function planForLookupKey(key: string): PlanId | null {
	for (const plan of Object.values(PLANS)) if (plan.stripe && (plan.stripe.base === key || plan.stripe.metered === key)) return plan.id;
	return null;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Free orgs bill on the UTC calendar month. Paid and custom orgs use the Stripe period stored
// on the profile, falling back to the calendar month until the first webhook has written it.
export function periodBounds(
	profile: { plan: string; period_start?: string; period_end?: string },
	now = Date.now(),
): { start: string; end: string } {
	if (profile.plan !== "free" && profile.period_start && profile.period_end) return { start: profile.period_start, end: profile.period_end };
	const d = new Date(now);
	return { start: isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
}

export function estimatedOverageUsd(plan: Plan, used: number): number {
	if (plan.overage_per_100k_usd === null) return 0;
	return (Math.max(0, used - plan.included_events) / 100_000) * plan.overage_per_100k_usd;
}
