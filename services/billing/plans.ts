import type { Limits, OrgProfile } from "../shared/accounts";

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

// Team and Pro: the plans with a Stripe subscription behind them.
export const isPaidPlan = (plan: string): plan is "team" | "pro" => plan === "team" || plan === "pro";

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Paid orgs use the Stripe period stored on the profile, falling back to the calendar month until
// the first webhook has written it. Everything else (free, custom, anything unknown) bills on the
// UTC calendar month, even if an old Stripe period is still on the profile: an org made custom
// mid-period would otherwise count against a period nothing renews.
export function periodBounds(
	profile: { plan: string; period_start?: string; period_end?: string },
	now = Date.now(),
): { start: string; end: string } {
	if (isPaidPlan(profile.plan) && profile.period_start && profile.period_end) return { start: profile.period_start, end: profile.period_end };
	const d = new Date(now);
	return { start: isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: isoDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
}

export function estimatedOverageUsd(plan: Plan, used: number): number {
	if (plan.overage_per_100k_usd === null) return 0;
	return (Math.max(0, used - plan.included_events) / 100_000) * plan.overage_per_100k_usd;
}

// Hot retention for an org. Custom and legacy orgs (and any plan this table doesn't know) get
// 30 days, never free's 7, so migrating them doesn't shorten what they already had.
export function retentionFor(profile?: { plan: string; retention_days?: number } | null): number {
	return profile?.retention_days ?? PLANS[profile?.plan as PlanId]?.retention_days ?? 30;
}

// Profiles written before `monthly_events` existed have none: free gets its plan cap and
// everything else stays uncapped, so an old paid or custom org is never throttled by a gap.
export function monthlyEventsFor(profile: { plan: string; limits: { monthly_events?: number | null } }): number | null {
	return profile.limits.monthly_events !== undefined ? profile.limits.monthly_events : (PLANS[profile.plan as PlanId]?.limits.monthly_events ?? null);
}

// The plan-derived Tenant fields, shared by every place that builds a tenant from a profile.
export function planFields(profile: OrgProfile, now = Date.now()) {
	const { start, end } = periodBounds(profile, now);
	return {
		plan: profile.plan,
		limits: { ...profile.limits, monthly_events: monthlyEventsFor(profile) },
		retention_days: retentionFor(profile),
		period_start: start,
		period_end: end,
	};
}
