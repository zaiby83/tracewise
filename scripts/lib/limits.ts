import { HOLDS_SUBSCRIPTION } from "../../services/billing/subscriptions";
import { FREE_LIMITS, type Limits } from "../../services/shared/accounts";

// Applies `key=value` overrides to an org's current limits. The keys are checked against
// the Limits type itself (via FREE_LIMITS), so a typo can't write a stray field.
export function parseLimitOverrides(pairs: string[], current: Limits): Limits {
	if (pairs.length === 0) throw new Error("give at least one key=value limit");
	const next = { ...current };
	for (const pair of pairs) {
		const at = pair.indexOf("=");
		if (at < 1) throw new Error(`"${pair}" is not key=value`);
		const key = pair.slice(0, at);
		const raw = pair.slice(at + 1);
		if (!Object.hasOwn(FREE_LIMITS, key)) throw new Error(`unknown limit "${key}" (known: ${Object.keys(FREE_LIMITS).join(", ")})`);
		// monthly_events is the one nullable limit: the literal `null` removes the cap.
		if (key === "monthly_events" && raw === "null") {
			next.monthly_events = null;
			continue;
		}
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${key} must be a non-negative integer${key === "monthly_events" ? " or null" : ""}, got "${raw}"`);
		next[key as keyof Limits] = Number(raw);
	}
	return next;
}

// Orgs an operator marks custom keep the 30 days of hot retention legacy tenants always had, whatever
// their plan was before: the Free plan's 7 days would silently shorten what they were promised. An org
// that is already custom keeps whatever retention the operator set for it.
// The Stripe period goes too: a custom org counts by calendar month, and nothing renews the old period.
export function customPatch(limits: Limits, currentPlan: string) {
	return { limits, plan: "custom" as const, ...(currentPlan === "custom" ? {} : { retention_days: 30 }), remove: ["period_start", "period_end"] as const };
}

// Why set-limits must not touch this org, or null. A custom org is never moved by the webhook, so
// one marked custom while Stripe still bills it would keep paying for a plan it no longer has.
export function setLimitsRefusal(billing: { status: string; subscription_id?: string | null } | null): string | null {
	if (!billing || !HOLDS_SUBSCRIPTION.has(billing.status)) return null;
	return `the org has a ${billing.status} Stripe subscription: cancel the Stripe subscription first (the owner can in Manage billing, or you can in the Stripe Dashboard), then run this again`;
}
