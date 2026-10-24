import { sameMode, type StripeMode } from "./mode";
import { stripeMode } from "./stripe";
import { getBilling, type BillingRecord } from "./subscriptions";

// The org's BILLING record as the configured Stripe key sees it: one from the other mode (test mode's,
// after the switch to live) is treated as no record at all. Returns the mode too, for writes that follow.
export async function currentBilling(orgId: string): Promise<{ billing: BillingRecord | null; mode: StripeMode }> {
	const [billing, mode] = await Promise.all([getBilling(orgId), stripeMode()]);
	return { billing: billing && sameMode(billing, mode) ? billing : null, mode };
}
