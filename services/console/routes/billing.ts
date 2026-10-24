import type Stripe from "stripe";
import { z } from "zod";
import { PLANS, estimatedOverageUsd, isPaidPlan, periodBounds, type PlanId } from "../../billing/plans";
import { findPortalConfigId, getStripe } from "../../billing/stripe";
import { currentBilling } from "../../billing/current";
import { HOLDS_SUBSCRIPTION, linkCustomer, rememberCustomer, setSpendCap, type BillingRecord } from "../../billing/subscriptions";
import { getProfile, type OrgProfile } from "../../shared/accounts";
import { json, log } from "../../shared/http";
import { counterIds, readCounter } from "../../shared/tenants";
import type { RouteTable } from "../handler";
import { bodyOf } from "./common";

const PaidPlan = z.object({ plan: z.enum(["team", "pro"]) });
const SpendCap = z.object({ spend_cap_usd: z.number().min(0).max(100_000).nullable() });

const LIVE = new Set(["active", "trialing", "past_due"]);
// Held open by Stripe but not being paid: the Customer Portal, not a second Checkout, sorts these out.
const PAYMENT_PROBLEM = new Set(["past_due", "unpaid", "incomplete"]);
// Paid plans are bought only once the operator turns them on (CDK context billingCheckout=true), so a
// deployed test-mode stack doesn't take sign-ups into a Checkout nobody is collecting for.
const checkoutEnabled = () => process.env.BILLING_CHECKOUT_ENABLED === "true";
const closed = () => json(403, { error: "paid plans aren't available yet" });
// Stripe accepts expiry 30 minutes to 24 hours after the session is created, so a little over 30 minutes
// leaves room for the time the request takes.
const CHECKOUT_TTL_SECONDS = 31 * 60;

const consoleUrl = (hash: string) => `${process.env.CONSOLE_ORIGIN}/console/index.html#/billing${hash}`;

// Stripe prices are found by lookup key, never by a configured id. Cached per Lambda instance: a
// price's id doesn't change, and only keys that were found are kept, so a price created after a cold
// start is picked up by the next call.
const priceIds = new Map<string, string>();
export const resetPriceCache = () => priceIds.clear();

async function pricesFor(stripe: Stripe, plan: Exclude<PlanId, "free">): Promise<{ base: string; metered: string }> {
	const keys = PLANS[plan].stripe!;
	if (!priceIds.has(keys.base) || !priceIds.has(keys.metered)) {
		const { data } = await stripe.prices.list({ lookup_keys: [keys.base, keys.metered], active: true });
		for (const price of data) if (price.lookup_key) priceIds.set(price.lookup_key, price.id);
	}
	const base = priceIds.get(keys.base);
	const metered = priceIds.get(keys.metered);
	// Names the lookup key, which is configuration and not a secret.
	if (!base) throw new Error(`Stripe price ${keys.base} not found`);
	if (!metered) throw new Error(`Stripe price ${keys.metered} not found`);
	return { base, metered };
}

const paid = (profile: OrgProfile): profile is OrgProfile & { plan: "team" | "pro" } => profile.plan === "team" || profile.plan === "pro";

// What the Billing screen shows. The plan's own fields describe a subscription only on a paid plan,
// whatever an old BILLING row says; billing_account and subscription_status report the record itself,
// so an org downgraded to Free can still reach Manage billing and see a payment problem. Customer,
// subscription and price ids never appear: nothing here needs them.
async function billingView(profile: OrgProfile, billing: BillingRecord | null) {
	const used = await readCounter(counterIds.period(profile.org_id, periodBounds(profile).start, isPaidPlan(profile.plan)));
	const plan = paid(profile) ? PLANS[profile.plan] : null;
	const sub = plan ? billing : null;
	return {
		plan: profile.plan,
		status: sub?.status ?? "none",
		current_period_end: sub?.current_period_end ?? null,
		cancel_at_period_end: sub ? sub.cancel_at_period_end : null,
		events_this_period: used,
		included_events: plan ? plan.included_events : profile.plan === "free" ? PLANS.free.included_events : null,
		// Whole cents, and never below zero (estimatedOverageUsd floors usage at the allowance).
		estimated_overage_usd: plan ? Math.round(estimatedOverageUsd(plan, used) * 100) / 100 : 0,
		spend_cap_usd: sub?.spend_cap_usd ?? null,
		past_due: sub?.status === "past_due",
		billing_account: !!billing?.customer_id,
		subscription_status: billing?.status ?? "none",
		checkout_enabled: checkoutEnabled(),
	};
}

const refuse = (error: string) => json(409, { error });

export const billingRoutes: RouteTable = {
	"GET /v1/orgs/{orgId}/billing": {
		access: "member",
		run: async (ctx) => {
			const profile = ctx.profile!;
			return json(200, await billingView(profile, (await currentBilling(profile.org_id)).billing));
		},
	},

	"POST /v1/orgs/{orgId}/billing/checkout": {
		access: "owner",
		run: async (ctx) => {
			if (!checkoutEnabled()) return closed();
			const { plan } = bodyOf(PaidPlan, ctx);
			const { org_id, plan: current } = ctx.profile!;
			// Custom plans are set by hand and the webhook never moves them, so a purchase would buy nothing.
			if (current === "custom") return refuse("plan is managed by Tracewise, contact support");
			// A record from the other Stripe mode counts as none: this key gets a customer of its own.
			const { billing, mode } = await currentBilling(org_id);
			if (billing && PAYMENT_PROBLEM.has(billing.status)) return refuse("there's a payment problem on your subscription — use Manage billing");
			if (billing && HOLDS_SUBSCRIPTION.has(billing.status)) return refuse("already subscribed, use Manage billing");

			const stripe = await getStripe();
			const prices = await pricesFor(stripe, plan);
			let customer = billing?.customer_id;
			if (!customer) {
				// One customer per org: the idempotency key makes a retry before the first webhook get the same
				// customer back, and rememberCustomer settles a race on whichever id was recorded first.
				const created = await stripe.customers.create({ email: ctx.claims.email || undefined, metadata: { org_id } }, { idempotencyKey: `customer-${org_id}` });
				// Throws if the customer is already tied to another org, so no session is created for it.
				await linkCustomer(org_id, created.id, mode === "live");
				customer = await rememberCustomer(org_id, created.id, mode === "live");
			}
			// A Checkout paid a moment ago has a subscription Stripe knows about before our webhook records it:
			// a second one now would subscribe the org twice.
			const subs = (await stripe.subscriptions.list({ customer, status: "all", limit: 10 })).data;
			if (subs.some((s) => HOLDS_SUBSCRIPTION.has(s.status))) return refuse("already subscribed, use Manage billing");
			// One open Checkout per org: a session left open (another tab, an abandoned try) could still be paid
			// after this one and make a second subscription.
			for (const open of (await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 })).data) {
				try {
					await stripe.checkout.sessions.expire(open.id);
				} catch (e) {
					// Completed or expired since the list: nothing left to expire.
					if ((e as { statusCode?: number }).statusCode !== 400) throw e;
				}
			}
			const session = await stripe.checkout.sessions.create({
				mode: "subscription",
				customer,
				client_reference_id: org_id,
				line_items: [{ price: prices.base, quantity: 1 }, { price: prices.metered }],
				// The webhook finds the org from the subscription's own metadata.
				subscription_data: { metadata: { org_id } },
				automatic_tax: { enabled: true },
				customer_update: { address: "auto" },
				allow_promotion_codes: true,
				expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS,
				success_url: consoleUrl("?checkout=success"),
				cancel_url: consoleUrl(""),
			});
			if (!session.url) throw new Error("Checkout session has no url");
			return json(200, { url: session.url });
		},
	},

	"POST /v1/orgs/{orgId}/billing/portal": {
		access: "owner",
		run: async (ctx) => {
			const { org_id } = ctx.profile!;
			const customer = (await currentBilling(org_id)).billing?.customer_id;
			if (!customer) return refuse("no billing account yet");
			const stripe = await getStripe();
			// The configuration `stripe-setup` maintains. Falling back to Stripe's default would show a
			// portal that lets customers change plans there, which a base-plus-metered subscription can't survive.
			const configuration = await findPortalConfigId(stripe);
			if (!configuration) {
				log("error", "billing portal is not configured", { route: "POST /v1/orgs/{orgId}/billing/portal", org_id, sub: ctx.claims.sub });
				return json(500, { error: "billing portal is not configured" });
			}
			const session = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: consoleUrl("") });
			return json(200, { url: session.url });
		},
	},

	// Plan switches happen here, not in the Customer Portal, which can't swap both items of a base-plus-metered
	// subscription reliably. The plan itself changes when the webhook delivers the update.
	"POST /v1/orgs/{orgId}/billing/change": {
		access: "owner",
		run: async (ctx) => {
			if (!checkoutEnabled()) return closed();
			const { plan } = bodyOf(PaidPlan, ctx);
			const profile = ctx.profile!;
			const { billing } = await currentBilling(profile.org_id);
			if (!billing?.subscription_id || !LIVE.has(billing.status)) return refuse("no active subscription");

			const stripe = await getStripe();
			const sub = await stripe.subscriptions.retrieve(billing.subscription_id);
			// Our record can lag Stripe by a webhook, so the subscription itself decides, here and below.
			if (!LIVE.has(sub.status)) return refuse("no active subscription");
			const baseKeys = new Set(Object.values(PLANS).flatMap((p) => (p.stripe ? [p.stripe.base] : [])));
			const meteredKeys = new Set(Object.values(PLANS).flatMap((p) => (p.stripe ? [p.stripe.metered] : [])));
			const base = sub.items.data.find((i) => !!i.price?.lookup_key && baseKeys.has(i.price.lookup_key));
			const metered = sub.items.data.find((i) => !!i.price?.lookup_key && meteredKeys.has(i.price.lookup_key));
			if (!base || !metered) throw new Error("subscription does not have a base and a metered item");
			if (base.price.lookup_key === PLANS[plan].stripe!.base) return refuse("already on that plan");

			const prices = await pricesFor(stripe, plan);
			await stripe.subscriptions.update(billing.subscription_id, {
				items: [{ id: base.id, price: prices.base }, { id: metered.id, price: prices.metered }],
				proration_behavior: "create_prorations",
			});
			return json(200, await billingView(profile, billing));
		},
	},

	"PATCH /v1/orgs/{orgId}/billing": {
		access: "owner",
		run: async (ctx) => {
			const { spend_cap_usd } = bodyOf(SpendCap, ctx);
			// One retry: the expected conflict is a plan change (a webhook or a downgrade) landing between our
			// read and the write, and the second pass derives the limit from the plan as it now stands.
			for (let attempt = 0; attempt < 2; attempt++) {
				const profile = attempt === 0 ? ctx.profile! : await getProfile(ctx.profile!.org_id);
				if (!profile || profile.status !== "active") return json(404, { error: "not found" });
				if (!paid(profile)) return refuse("spend caps apply to paid plans");
				if (await setSpendCap(profile.org_id, profile.plan, spend_cap_usd)) {
					return json(200, await billingView(profile, (await currentBilling(profile.org_id)).billing));
				}
			}
			return refuse("billing changed, try again");
		},
	},
};
