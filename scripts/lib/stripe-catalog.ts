import Stripe from "stripe";
import { PLANS, type Plan } from "../../services/billing/plans";

export const METER_EVENT_NAME = "tracewise_events";
const PORTAL_TAG = { tracewise: "plan-switching" };
const Decimal = Stripe.Decimal;

type PaidPlan = Plan & { stripe: { base: string; metered: string } };
const paidPlans = (): PaidPlan[] => Object.values(PLANS).filter((p): p is PaidPlan => p.stripe !== null);

// Fixed ids make "does the product exist" a lookup, and keep a rerun after a half-finished
// run from creating a second product.
const productId = (plan: Plan) => `tracewise_${plan.id}`;

// Dollars per 100,000 events -> cents per event, as an exact decimal ($5 -> 0.005).
const overageCentsPerEvent = (plan: Plan) => Decimal.from(plan.overage_per_100k_usd ?? 0).mul(Decimal.from("0.001"));

// Tiers as the metered price should have them. The wire value of unit_amount_decimal is its
// decimal string, whichever of Decimal or string Stripe hands back.
const expectedTiers = (plan: Plan) => [
	{ up_to: plan.included_events, unit_amount: 0 },
	{ up_to: "inf" as const, unit_amount_decimal: overageCentsPerEvent(plan) },
];

const mismatch = (what: string, why: string): never => {
	throw new Error(`${what} already exists in Stripe but ${why}. Prices are immutable: archive it in the Dashboard (and free its lookup key) so it can be recreated, or fix the plan table.`);
};

function sameDecimal(actual: unknown, expected: string | number): boolean {
	if (actual === null || actual === undefined) return false;
	return Decimal.from(String(actual)).cmp(Decimal.from(expected)) === 0;
}

function checkMeter(m: Stripe.Billing.Meter): void {
	const bad = (why: string): never => {
		throw new Error(`Meter "${METER_EVENT_NAME}" (${m.id}) already exists but ${why}. Meters can't be reconfigured: fix or deactivate it in the Dashboard.`);
	};
	if (m.status !== "active") bad("is inactive");
	if (m.default_aggregation.formula !== "sum") bad("does not sum its events");
	if (m.customer_mapping.type !== "by_id" || m.customer_mapping.event_payload_key !== "stripe_customer_id") bad("does not map customers by stripe_customer_id");
	if (m.value_settings.event_payload_key !== "value") bad("does not read its value from the payload key 'value'");
}

function checkBase(price: Stripe.Price, plan: PaidPlan): void {
	const key = plan.stripe.base;
	const what = `Price "${key}" (${price.id})`;
	if (!price.active) mismatch(what, "is archived");
	if (price.currency !== "usd") mismatch(what, `is in ${price.currency}, not usd`);
	const expected = plan.price_usd * 100;
	if (price.billing_scheme !== "per_unit" || price.unit_amount !== expected) mismatch(what, `is ${price.unit_amount ?? "tiered"} cents, not ${expected}`);
	const r = price.recurring;
	if (!r || r.interval !== "month" || r.interval_count !== 1 || r.usage_type !== "licensed") mismatch(what, "is not a licensed monthly price");
}

function checkMetered(price: Stripe.Price, plan: PaidPlan, meterId: string): void {
	const key = plan.stripe.metered;
	const what = `Price "${key}" (${price.id})`;
	if (!price.active) mismatch(what, "is archived");
	if (price.currency !== "usd") mismatch(what, `is in ${price.currency}, not usd`);
	const r = price.recurring;
	if (!r || r.interval !== "month" || r.interval_count !== 1 || r.usage_type !== "metered") mismatch(what, "is not a metered monthly price");
	if (r?.meter !== meterId) mismatch(what, `is bound to meter ${r?.meter ?? "none"}, not ${meterId}`);
	const tiers = price.tiers ?? [];
	const [free, overage] = tiers;
	const ok =
		price.billing_scheme === "tiered" &&
		price.tiers_mode === "graduated" &&
		tiers.length === 2 &&
		free?.up_to === plan.included_events &&
		sameDecimal(free.unit_amount_decimal ?? free.unit_amount, 0) &&
		overage?.up_to === null &&
		sameDecimal(overage.unit_amount_decimal, String(overageCentsPerEvent(plan)));
	if (!ok) mismatch(what, `does not have the graduated tiers 0 up to ${plan.included_events} events, then ${overageCentsPerEvent(plan)} cents per event`);
}

const idOf = (p: string | { id: string }) => (typeof p === "string" ? p : p.id);

// Idempotent: finds the meter by event name and prices by lookup key, creates whatever is
// missing, and never edits an existing object. Only ids come back; nothing here touches a key.
export async function ensureStripeCatalog(stripe: Stripe): Promise<{ meterId: string; prices: Record<string, string>; portalConfigId: string }> {
	const meters = (await stripe.billing.meters.list({ limit: 100 })).data.filter((m) => m.event_name === METER_EVENT_NAME);
	let meter = meters.find((m) => m.status === "active") ?? meters[0];
	if (meter) checkMeter(meter);
	else {
		meter = await stripe.billing.meters.create({
			display_name: "Tracewise events",
			event_name: METER_EVENT_NAME,
			default_aggregation: { formula: "sum" },
			customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
			value_settings: { event_payload_key: "value" },
		});
	}
	const meterId = meter.id;

	const plans = paidPlans();
	// Tiers only come back from the list when asked for.
	const existing = (await stripe.prices.list({ lookup_keys: plans.flatMap((p) => [p.stripe.base, p.stripe.metered]), expand: ["data.tiers"], limit: 100 })).data;
	const byKey = new Map(existing.flatMap((p) => (p.lookup_key ? [[p.lookup_key, p] as const] : [])));

	const prices: Record<string, string> = {};
	const products: Record<string, string> = {};
	for (const plan of plans) {
		const { base, metered } = plan.stripe;
		const have = { base: byKey.get(base), metered: byKey.get(metered) };
		if (have.base) checkBase(have.base, plan);
		if (have.metered) checkMetered(have.metered, plan, meterId);

		// Create the product only when a price needs it; otherwise reuse the one the prices sit on.
		let product = have.base ? idOf(have.base.product) : have.metered ? idOf(have.metered.product) : undefined;
		if (!product && (!have.base || !have.metered)) {
			const found = (await stripe.products.list({ ids: [productId(plan)] })).data[0];
			product = found?.id ?? (await stripe.products.create({ id: productId(plan), name: `Tracewise ${plan.name}` })).id;
		}
		products[plan.id] = product!;

		const baseId = have.base?.id ?? (await stripe.prices.create({
			currency: "usd",
			product,
			lookup_key: base,
			nickname: `${plan.name} monthly`,
			unit_amount: plan.price_usd * 100,
			recurring: { interval: "month" },
		})).id;
		const meteredId = have.metered?.id ?? (await stripe.prices.create({
			currency: "usd",
			product,
			lookup_key: metered,
			nickname: `${plan.name} events`,
			billing_scheme: "tiered",
			tiers_mode: "graduated",
			tiers: expectedTiers(plan),
			recurring: { interval: "month", usage_type: "metered", meter: meterId },
		})).id;
		prices[base] = baseId;
		prices[metered] = meteredId;
	}

	const portals = (await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data;
	const portal =
		portals.find((c) => c.metadata?.tracewise === PORTAL_TAG.tracewise) ??
		(await stripe.billingPortal.configurations.create({
			name: "Tracewise plan switching",
			metadata: PORTAL_TAG,
			features: {
				subscription_update: {
					enabled: true,
					default_allowed_updates: ["price"],
					proration_behavior: "create_prorations",
					products: plans.map((plan) => ({ product: products[plan.id]!, prices: [prices[plan.stripe.base]!] })),
				},
				subscription_cancel: { enabled: true, mode: "at_period_end" },
				payment_method_update: { enabled: true },
				invoice_history: { enabled: true },
			},
		}));

	return { meterId, prices, portalConfigId: portal.id };
}

const USAGE = "usage: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts [--live]";

// Checked before any network call. Never repeats the key it was given.
export function validateSetupArgs(argv: string[], env: Record<string, string | undefined>): { ok: true } | { ok: false; message: string } {
	const unknown = argv.filter((a) => a !== "--live");
	if (unknown.length) return { ok: false, message: `unknown argument ${unknown[0]}\n${USAGE}` };
	const key = env.STRIPE_SECRET_KEY;
	if (!key) return { ok: false, message: `STRIPE_SECRET_KEY is not set\n${USAGE}` };
	if (!/^[sr]k_(test|live)_/.test(key)) return { ok: false, message: `STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_test_... or sk_live_...)\n${USAGE}` };
	if (/^[sr]k_live_/.test(key) && !argv.includes("--live")) return { ok: false, message: `refusing to run against live mode without --live\n${USAGE}` };
	return { ok: true };
}
