import { PLANS, type Plan } from "../../services/billing/plans";

export const SMOKE_BILLING_USAGE = [
	"usage: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/smoke-billing.ts [--overage]",
	"Runs the billing flow against the deployed stack in Stripe test mode: a Team subscription on a test clock, the webhook,",
	"ingest, the meter, the period-end invoice and a cancellation. Live keys are refused.",
	"  --overage  also ingests 500,001 events and checks the overage line. It is paced by Team's 6,000 events a minute limit,",
	"             so it takes about 90 minutes and costs about $1.50 of AWS.",
	"Reads the stack outputs UserPoolId, SmokeClientId, DashboardUrl, AccountsTable and QuotasTable (deploy with --context smokeClient=true),",
	"and needs your AWS credentials for Cognito admin and the Accounts and Quotas tables. The webhook must be registered first (see the README).",
].join("\n");

export type SmokeArgs = { ok: true; overage: boolean } | { ok: false; help: boolean; message: string };

// Checked before any network call. Never repeats the key it was given.
export function validateSmokeArgs(argv: string[], env: Record<string, string | undefined>): SmokeArgs {
	if (argv.includes("-h") || argv.includes("--help")) return { ok: false, help: true, message: SMOKE_BILLING_USAGE };
	const unknown = argv.filter((a) => a !== "--overage");
	if (unknown.length) return { ok: false, help: false, message: `unknown argument ${unknown[0]}\n${SMOKE_BILLING_USAGE}` };
	const key = env.STRIPE_SECRET_KEY;
	if (!key) return { ok: false, help: false, message: `STRIPE_SECRET_KEY is not set\n${SMOKE_BILLING_USAGE}` };
	if (/^[sr]k_live_/.test(key)) return { ok: false, help: false, message: `refusing to run against live mode: this script needs a test key (sk_test_...)\n${SMOKE_BILLING_USAGE}` };
	if (!/^[sr]k_test_/.test(key)) return { ok: false, help: false, message: `STRIPE_SECRET_KEY is not a Stripe test secret key (expected sk_test_...)\n${SMOKE_BILLING_USAGE}` };
	return { ok: true, overage: argv.includes("--overage") };
}

// What the plan's graduated metered price charges for `events`, in whole cents the way an invoice
// line shows it: the first `included_events` are free, each one after costs overage_per_100k / 100,000.
export function expectedMeteredCents(plan: Plan, events: number): number {
	if (plan.overage_per_100k_usd === null) return 0;
	const over = Math.max(0, events - plan.included_events);
	return Math.round((over * plan.overage_per_100k_usd * 100) / 100_000);
}

export const TEAM_BASE_CENTS = PLANS.team.price_usd * 100;
