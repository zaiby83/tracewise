// Adds another API key to an existing org, e.g. a read-only key for a dashboard.
// Usage: pnpm exec tsx scripts/create-key.ts "<org name>" [read|write]
import { createKey, findOrgByName } from "../services/console/store";
import { stackOutputs } from "./lib/stack";

const [name, scope = "read"] = process.argv.slice(2);
if (!name || (scope !== "read" && scope !== "write")) {
	console.error('usage: pnpm exec tsx scripts/create-key.ts "<org name>" [read|write]');
	process.exit(1);
}

await stackOutputs();
const org = await findOrgByName(name);
if (!org) throw new Error(`no org named "${name}"`);

const { secret } = await createKey(org.org_id, { name: scope === "read" ? "Read key" : "Write key", scope, created_by: "operator" });
console.error(`Added a ${scope} key to "${name}" (${org.org_id}). Shown once:`);
console.log(secret);
