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
// their plan was before: the Free plan's 7 days would silently shorten what they were promised.
export function customPatch(limits: Limits) {
	return { limits, plan: "custom" as const, retention_days: 30 };
}
