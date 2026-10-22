// Creates an org with a write key and prints the key once. Only the key's hash is stored.
// It is the same createOrg the console uses, with limits that keep an operator-created
// tenant (a load test, a demo) at today's rates instead of the free tier's.
// Usage: pnpm tenant:create "<tenant name>" [eventsPerMinute]
import { createOrg } from "../services/console/store";
import { legacyLimits } from "../services/shared/accounts";
import { stackOutputs } from "./lib/stack";

const [name, perMinute = "6000"] = process.argv.slice(2);
if (!name || !/^[1-9]\d*$/.test(perMinute)) {
	console.error('usage: pnpm tenant:create "<tenant name>" [eventsPerMinute]');
	process.exit(1);
}

const outputs = await stackOutputs();
const { org, key } = await createOrg({ name, plan: "custom", limits: legacyLimits(Number(perMinute)) });

console.error(`Created tenant "${name}" (${org.org_id}), ${perMinute} events/min.`);
console.error("API key (shown once, store it somewhere safe):");
console.log(key.secret);
console.error(`Ingest endpoint: ${outputs.ApiUrl}/v1/traces`);
