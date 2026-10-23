import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { ensureStripeCatalog, validateSetupArgs } from "../scripts/lib/stripe-catalog";

// A hand-written stand-in for the parts of the Stripe client the setup uses. Lists return what
// was seeded; creates mint ids and record the call.
interface Seed {
	meters?: unknown[];
	products?: unknown[];
	prices?: unknown[];
	portals?: unknown[];
}
const stubStripe = (seed: Seed = {}) => {
	const list = (data: unknown[] = []) => vi.fn().mockResolvedValue({ data });
	const create = (prefix: string) => vi.fn(async (params: object) => ({ id: `${prefix}_new${Math.random().toString(36).slice(2, 6)}`, ...params }));
	return {
		billing: { meters: { list: list(seed.meters), create: create("mtr") } },
		// Honours the ids filter, like Stripe does.
		products: { list: vi.fn(async (p: { ids?: string[] }) => ({ data: (seed.products ?? []).filter((x) => !p.ids || p.ids.includes((x as { id: string }).id)) })), create: create("prod") },
		prices: { list: list(seed.prices), create: create("price") },
		billingPortal: { configurations: { list: list(seed.portals), create: create("bpc") } },
	} as unknown as Stripe & {
		billing: { meters: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } };
		products: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
		prices: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
		billingPortal: { configurations: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } };
	};
};

const meter = { id: "mtr_1", status: "active", event_name: "tracewise_events", default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } };
const base = (key: string, product: string, amount: number) => ({
	id: `price_${key}`, lookup_key: key, active: true, product, currency: "usd", billing_scheme: "per_unit", unit_amount: amount,
	recurring: { interval: "month", interval_count: 1, usage_type: "licensed", meter: null },
});
const metered = (key: string, product: string, upTo: number, decimal: string, meterId = "mtr_1") => ({
	id: `price_${key}`, lookup_key: key, active: true, product, currency: "usd", billing_scheme: "tiered", tiers_mode: "graduated", unit_amount: null,
	recurring: { interval: "month", interval_count: 1, usage_type: "metered", meter: meterId },
	tiers: [{ up_to: upTo, unit_amount: 0, unit_amount_decimal: "0", flat_amount: null }, { up_to: null, unit_amount: null, unit_amount_decimal: decimal, flat_amount: null }],
});
const portal = { id: "bpc_1", active: true, metadata: { tracewise: "plan-switching" } };
const everything = (): Seed => ({
	meters: [meter],
	prices: [
		base("team_monthly", "prod_team", 2_900),
		metered("team_metered", "prod_team", 500_000, "0.005"),
		base("pro_monthly", "prod_pro", 19_900),
		metered("pro_metered", "prod_pro", 5_000_000, "0.003"),
	],
	portals: [portal],
});

const callsOf = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => c[0] as Record<string, unknown>);
const decimalString = (v: unknown) => String(v);

describe("ensureStripeCatalog", () => {
	it("creates the meter, products and prices when none exist, with the published tiers", async () => {
		const s = stubStripe();
		const out = await ensureStripeCatalog(s);

		expect(s.billing.meters.create).toHaveBeenCalledWith(
			expect.objectContaining({
				event_name: "tracewise_events",
				default_aggregation: { formula: "sum" },
				customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
				value_settings: { event_payload_key: "value" },
			}),
		);
		expect(callsOf(s.products.create).map((p) => p.name)).toEqual(["Tracewise Team", "Tracewise Pro"]);
		expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({ lookup_key: "team_monthly", unit_amount: 2_900, currency: "usd", recurring: expect.objectContaining({ interval: "month" }) }));
		expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({ lookup_key: "pro_monthly", unit_amount: 19_900, recurring: expect.objectContaining({ interval: "month" }) }));

		const prices = callsOf(s.prices.create);
		const team = prices.find((p) => p.lookup_key === "team_metered")!;
		const pro = prices.find((p) => p.lookup_key === "pro_metered")!;
		expect(team).toMatchObject({ billing_scheme: "tiered", tiers_mode: "graduated", recurring: { interval: "month", usage_type: "metered", meter: out.meterId } });
		// unit_amount_decimal is a Stripe Decimal in the typings; compare its wire string.
		const tiersOf = (p: Record<string, unknown>) => (p.tiers as Record<string, unknown>[]).map((t) => ({ ...t, ...(t.unit_amount_decimal === undefined ? {} : { unit_amount_decimal: decimalString(t.unit_amount_decimal) }) }));
		expect(tiersOf(team)).toEqual([{ up_to: 500_000, unit_amount: 0 }, { up_to: "inf", unit_amount_decimal: "0.005" }]);
		expect(tiersOf(pro)).toEqual([{ up_to: 5_000_000, unit_amount: 0 }, { up_to: "inf", unit_amount_decimal: "0.003" }]);

		expect(Object.keys(out.prices).sort()).toEqual(["pro_metered", "pro_monthly", "team_metered", "team_monthly"]);
		expect(new Set(Object.values(out.prices)).size).toBe(4);
		expect(out.meterId).toMatch(/^mtr_/);
	});

	it("puts each plan's prices on its own product and reuses a product that already exists", async () => {
		const s = stubStripe({ ...everything(), prices: [], products: [{ id: "tracewise_team" }] });
		await ensureStripeCatalog(s);
		expect(callsOf(s.products.create).map((p) => p.name)).toEqual(["Tracewise Pro"]);
		const byKey = Object.fromEntries(callsOf(s.prices.create).map((p) => [p.lookup_key, p.product]));
		expect(byKey.team_monthly).toBe("tracewise_team");
		expect(byKey.team_metered).toBe("tracewise_team");
		expect(byKey.pro_monthly).toBe(byKey.pro_metered);
		expect(byKey.pro_monthly).not.toBe("tracewise_team");
	});

	it("creates a portal configuration that switches between the two monthly plans", async () => {
		const s = stubStripe({ ...everything(), portals: [] });
		const out = await ensureStripeCatalog(s);
		const [config] = callsOf(s.billingPortal.configurations.create) as [{ metadata: unknown; features: Record<string, unknown> }];
		expect(config.metadata).toEqual({ tracewise: "plan-switching" });
		expect(config.features).toMatchObject({
			subscription_cancel: { enabled: true, mode: "at_period_end" },
			payment_method_update: { enabled: true },
			invoice_history: { enabled: true },
			subscription_update: {
				enabled: true,
				default_allowed_updates: ["price"],
				products: [
					{ product: "prod_team", prices: ["price_team_monthly"] },
					{ product: "prod_pro", prices: ["price_pro_monthly"] },
				],
			},
		});
		expect(out.portalConfigId).toMatch(/^bpc_/);
	});

	it("is a no-op when everything exists", async () => {
		const s = stubStripe(everything());
		const out = await ensureStripeCatalog(s);
		expect(s.billing.meters.create).not.toHaveBeenCalled();
		expect(s.products.create).not.toHaveBeenCalled();
		expect(s.prices.create).not.toHaveBeenCalled();
		expect(s.billingPortal.configurations.create).not.toHaveBeenCalled();
		expect(out).toEqual({
			meterId: "mtr_1",
			prices: { team_monthly: "price_team_monthly", team_metered: "price_team_metered", pro_monthly: "price_pro_monthly", pro_metered: "price_pro_metered" },
			portalConfigId: "bpc_1",
		});
	});

	it("looks the prices up by lookup key and asks for their tiers", async () => {
		const s = stubStripe(everything());
		await ensureStripeCatalog(s);
		expect(s.prices.list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ["team_monthly", "team_metered", "pro_monthly", "pro_metered"], expand: ["data.tiers"] }));
	});

	it("only creates what is missing", async () => {
		const seed = everything();
		seed.prices = seed.prices!.filter((p) => (p as { lookup_key: string }).lookup_key !== "pro_metered");
		const s = stubStripe(seed);
		await ensureStripeCatalog(s);
		expect(callsOf(s.prices.create).map((p) => p.lookup_key)).toEqual(["pro_metered"]);
		// It joins the product its sibling price already sits on instead of making a new one.
		expect(callsOf(s.prices.create)[0]!.product).toBe("prod_pro");
		expect(s.products.create).not.toHaveBeenCalled();
	});

	it("refuses to continue when an existing price has the wrong amount", async () => {
		const seed = everything();
		seed.prices = [base("team_monthly", "prod_team", 2_500), ...seed.prices!.slice(1)];
		const s = stubStripe(seed);
		await expect(ensureStripeCatalog(s)).rejects.toThrow(/team_monthly/);
		expect(s.prices.create).not.toHaveBeenCalled();
	});

	it("refuses an existing metered price whose tiers differ", async () => {
		const seed = everything();
		seed.prices = [...seed.prices!.slice(0, 3), metered("pro_metered", "prod_pro", 5_000_000, "0.004")];
		await expect(ensureStripeCatalog(stubStripe(seed))).rejects.toThrow(/pro_metered/);
		seed.prices = [...seed.prices.slice(0, 3), metered("pro_metered", "prod_pro", 4_000_000, "0.003")];
		await expect(ensureStripeCatalog(stubStripe(seed))).rejects.toThrow(/pro_metered/);
	});

	it("refuses a metered price that is bound to a different meter", async () => {
		const seed = everything();
		seed.prices = [...seed.prices!.slice(0, 1), metered("team_metered", "prod_team", 500_000, "0.005", "mtr_other"), ...seed.prices!.slice(2)];
		await expect(ensureStripeCatalog(stubStripe(seed))).rejects.toThrow(/team_metered/);
	});

	it("refuses an archived price holding a lookup key", async () => {
		const seed = everything();
		seed.prices = [{ ...(seed.prices![0] as object), active: false }, ...seed.prices!.slice(1)];
		await expect(ensureStripeCatalog(stubStripe(seed))).rejects.toThrow(/team_monthly.*archived/);
	});

	it("refuses an existing meter with different settings", async () => {
		const seed = everything();
		seed.meters = [{ ...meter, default_aggregation: { formula: "count" } }];
		const s = stubStripe(seed);
		await expect(ensureStripeCatalog(s)).rejects.toThrow(/tracewise_events/);
		expect(s.prices.create).not.toHaveBeenCalled();
	});
});

describe("validateSetupArgs", () => {
	const KEY = "sk_test_abc";
	it("needs STRIPE_SECRET_KEY and prints usage", () => {
		const r = validateSetupArgs([], {});
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toMatch(/STRIPE_SECRET_KEY=sk_test_.*stripe-setup\.ts/);
	});
	it("refuses a live key without --live, and never echoes the key", () => {
		const r = validateSetupArgs([], { STRIPE_SECRET_KEY: "sk_live_supersecret" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.message).toMatch(/--live/);
		expect(JSON.stringify(r)).not.toContain("supersecret");
	});
	it("accepts a live key with --live and a test key without it", () => {
		expect(validateSetupArgs(["--live"], { STRIPE_SECRET_KEY: "sk_live_x" })).toEqual({ ok: true });
		expect(validateSetupArgs([], { STRIPE_SECRET_KEY: KEY })).toEqual({ ok: true });
	});
	it("rejects a value that is not a Stripe secret key, and unknown flags", () => {
		expect(validateSetupArgs([], { STRIPE_SECRET_KEY: "pk_test_publishable" }).ok).toBe(false);
		expect(validateSetupArgs(["--wat"], { STRIPE_SECRET_KEY: KEY }).ok).toBe(false);
	});
});
