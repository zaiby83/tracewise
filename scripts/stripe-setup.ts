// Creates the Stripe meter, products, prices and Customer Portal configuration, or confirms
// they already exist. Safe to rerun. Prints object ids only, never the key.
// Usage: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/stripe-setup.ts [--live]
import { getStripe } from "../services/billing/stripe";
import { ensureStripeCatalog, validateSetupArgs } from "./lib/stripe-catalog";

const args = process.argv.slice(2);
const checked = validateSetupArgs(args, process.env);
if (!checked.ok) {
	console.error(checked.message);
	process.exit(1);
}

const result = await ensureStripeCatalog(await getStripe());
console.log(JSON.stringify(result, null, 2));
