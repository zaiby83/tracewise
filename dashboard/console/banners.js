// What the console tells you about your plan, whatever screen you are on. Pure: no DOM, so the
// rules can be tested without a browser. The shell fetches billing and shows what this returns.

import { int } from "../shared/format.js";

const WARN_AT = 0.8;
const PAYMENT_PROBLEM = new Set(["past_due", "unpaid"]);

// `billing` is GET /v1/orgs/{id}/billing. `usage` (GET /v1/orgs/{id}/usage) is optional: its
// limits.monthly_events is the exact ceiling ingest enforces, which a spend cap moves.
export function bannersFor(billing, usage) {
	if (!billing) return [];
	const used = billing.events_this_period ?? 0;
	const included = billing.included_events;
	const free = billing.plan === "free";

	// A failed payment is the most urgent thing, and the allowances below say nothing it doesn't.
	if (billing.past_due) {
		return [{ kind: "danger", text: "Your last payment failed. An owner needs to update the payment method within 7 days, or your organization moves to Free limits." }];
	}
	// Past the grace period the org is on Free, but Stripe still holds the subscription and its unpaid invoice.
	if (PAYMENT_PROBLEM.has(billing.subscription_status)) {
		return [{ kind: "danger", text: "There's a payment problem on your subscription, so your organization is on Free limits. An owner can pay the open invoice or cancel it in Manage billing on the Billing page." }];
	}
	if (!included) return [];

	const ceiling = usage?.limits?.monthly_events;
	const cap = billing.spend_cap_usd;
	// A $0 cap stops ingest at the plan's allowance, so a cap only counts as reached once the allowance is
	// used. Without the usage endpoint's exact ceiling, the estimated overage stands in for it.
	const capReached = !free && typeof cap === "number" && used >= included && (typeof ceiling === "number" ? used >= ceiling : (billing.estimated_overage_usd ?? 0) >= cap);

	if (capReached) {
		return [{ kind: "danger", text: `You've reached your $${cap} spend cap. Ingest returns 429 until the period ends; raise the cap on the Billing page to keep collecting events.` }];
	}
	if (used >= included) {
		return [
			free
				? { kind: "danger", text: `You've used all ${int.format(included)} events included in the Free plan. Ingest returns 429 until the period ends; upgrade to keep collecting events.` }
				: { kind: "info", text: `You've used all ${int.format(included)} included events. Further events are billed as overage.` },
		];
	}
	if (used >= included * WARN_AT) return [{ kind: "warn", text: `You've used ${Math.floor((used / included) * 100)}% of the ${int.format(included)} events included in your plan this period.` }];
	return [];
}
