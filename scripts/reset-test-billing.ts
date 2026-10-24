// The test-to-live reset. Once the Stripe secret holds live keys, test-mode BILLING and STRIPE# rows are
// ignored automatically, but an org upgraded in test mode keeps its Team or Pro plan. This moves every
// active paid org that no live subscription pays for to Free, the way a cancellation would
// (applySubscription with no subscription). Prints the plan; writes only with --apply.
// Usage: STRIPE_SECRET_KEY=sk_live_... pnpm exec tsx scripts/reset-test-billing.ts [--apply]
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { applySubscription } from "../services/billing/subscriptions";
import { ddb } from "../services/shared/ddb";
import { planTestBillingReset, validateResetArgs } from "./lib/reset-test-billing";
import { stackOutputs } from "./lib/stack";

const args = validateResetArgs(process.argv.slice(2), process.env);
if (!args.ok) {
	(args.help ? console.log : console.error)(args.message);
	process.exit(args.help ? 0 : 1);
}

await stackOutputs();

async function scan(sk: string): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(
			new ScanCommand({ TableName: process.env.ACCOUNTS_TABLE, FilterExpression: "sk = :sk", ExpressionAttributeValues: { ":sk": sk }, ExclusiveStartKey: startKey }),
		);
		items.push(...(page.Items ?? []));
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return items;
}

const [profiles, billings] = await Promise.all([scan("PROFILE"), scan("BILLING")]);
const plan = planTestBillingReset(profiles as never, billings as never);
for (const r of plan.reset) console.log(`${args.apply ? "resetting" : "would reset"} ${r.org_id} (${r.plan}): ${r.reason}`);
console.error(`${plan.reset.length} paid orgs to move to Free, ${plan.kept} kept on a live subscription.`);
if (!args.apply) {
	if (plan.reset.length > 0) console.error("Dry run: nothing written. Run again with --apply to move them.");
	process.exit(0);
}

let applied = 0;
let skipped = 0;
for (const r of plan.reset) {
	// Re-reads the org first and skips one that changed since the scan (custom, deleting, suspended).
	const result = await applySubscription(r.org_id, null);
	if (result.applied) applied++;
	else skipped++;
}
console.error(`Moved ${applied} orgs to Free${skipped ? `; ${skipped} changed since the scan and were left alone` : ""}.`);
