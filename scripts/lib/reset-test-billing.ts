import { HOLDS_SUBSCRIPTION } from "../../services/billing/subscriptions";
import { isPaidPlan } from "../../services/billing/plans";
import { sameMode } from "../../services/billing/mode";

export const RESET_USAGE = [
	"usage: STRIPE_SECRET_KEY=sk_live_... pnpm exec tsx scripts/reset-test-billing.ts [--apply]",
	"After the Stripe secret moves to live keys: moves to Free every active Team or Pro org that no live",
	"subscription pays for (its plan came from test mode, or from a Checkout that was never finished).",
	"Without --apply it only prints what it would change. Never calls Stripe; the key only proves live mode.",
].join("\n");

export type ResetArgs = { ok: true; apply: boolean } | { ok: false; help: boolean; message: string };

// Checked before any AWS call. Never repeats the key it was given.
export function validateResetArgs(argv: string[], env: Record<string, string | undefined>): ResetArgs {
	if (argv.includes("-h") || argv.includes("--help")) return { ok: false, help: true, message: RESET_USAGE };
	const unknown = argv.filter((a) => a !== "--apply");
	if (unknown.length) return { ok: false, help: false, message: `unknown argument ${unknown[0]}\n${RESET_USAGE}` };
	const key = env.STRIPE_SECRET_KEY;
	if (!key) return { ok: false, help: false, message: `STRIPE_SECRET_KEY is not set\n${RESET_USAGE}` };
	if (!/^[sr]k_live_/.test(key)) return { ok: false, help: false, message: `this resets test-mode billing once the stack runs on a live key: give it the live key (sk_live_...)\n${RESET_USAGE}` };
	return { ok: true, apply: argv.includes("--apply") };
}

interface ProfileRow {
	org_id: string;
	plan: string;
	status: string;
}
interface BillingRow {
	org_id: string;
	status: string;
	livemode?: boolean | null;
}

export interface ResetPlan {
	reset: { org_id: string; plan: string; reason: "test-mode subscription" | "no live subscription" }[];
	// Paid orgs a live subscription still holds, left to the webhook.
	kept: number;
}

// Pure: which orgs to move to Free. Only active Team and Pro orgs are candidates; free, custom and
// non-active orgs are never touched (test-mode BILLING rows on them are already ignored by a live key).
export function planTestBillingReset(profiles: ProfileRow[], billings: BillingRow[]): ResetPlan {
	const byOrg = new Map(billings.map((b) => [b.org_id, b]));
	const plan: ResetPlan = { reset: [], kept: 0 };
	for (const p of profiles) {
		if (p.status !== "active" || !isPaidPlan(p.plan)) continue;
		const b = byOrg.get(p.org_id);
		if (b && sameMode(b, "live") && HOLDS_SUBSCRIPTION.has(b.status)) {
			plan.kept++;
			continue;
		}
		plan.reset.push({ org_id: p.org_id, plan: p.plan, reason: b && !sameMode(b, "live") ? "test-mode subscription" : "no live subscription" });
	}
	return plan;
}
