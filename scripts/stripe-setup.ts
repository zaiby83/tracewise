// Creates the Stripe meter, products, prices and Customer Portal configuration, or confirms
// they already exist, then checks Stripe Tax is set up (Checkout needs it). Safe to rerun.
// Prints object ids only, never the key.
// Usage: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts [--live] [--skip-tax-check]
import { getStripe } from "../services/billing/stripe";
import { checkStripeTax, ensureStripeCatalog, validateSetupArgs } from "./lib/stripe-catalog";

const args = process.argv.slice(2);
const checked = validateSetupArgs(args, process.env);
if (!checked.ok) {
	console.error(checked.message);
	process.exit(1);
}

const stripe = await getStripe();
const result = await ensureStripeCatalog(stripe);
console.log(JSON.stringify(result, null, 2));

if (checked.skipTaxCheck) {
	console.error("Skipped the Stripe Tax check: Checkout fails until Stripe Tax is active in this mode.");
} else {
	const tax = await checkStripeTax(stripe);
	if (!tax.ok) {
		console.error(tax.message);
		process.exit(1);
	}
	console.error("Stripe Tax is active.");
}
