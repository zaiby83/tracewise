// Moves the pre-self-serve key index into orgs: a PROFILE per tenant, a KEY item per key, and
// each index row rewritten to the lean shape. With --owner, the Cognito user with that email
// becomes the owner of the orgs this run creates and of active orgs that have no owner yet,
// so it can be given on a later run. Safe to run again: it changes nothing that is already
// migrated.
// Usage: pnpm exec tsx scripts/migrate-accounts.ts [--owner you@example.com]
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { applyPlan, planMigration, scanKeyIndex, scanProfiles } from "./lib/migrate";
import { stackOutputs } from "./lib/stack";

const usage = () => {
	console.error("usage: pnpm exec tsx scripts/migrate-accounts.ts [--owner email]");
	process.exit(1);
};

const args = process.argv.slice(2);
let ownerEmail: string | undefined;
if (args.length > 0) {
	if (args.length !== 2 || args[0] !== "--owner" || !args[1]?.includes("@")) usage();
	ownerEmail = args[1];
}

const outputs = await stackOutputs();

// Resolved before anything is written, so a typo in the email stops the run cleanly.
let owner: { sub: string; email: string } | undefined;
if (ownerEmail) {
	if (!outputs.UserPoolId) throw new Error("the stack has no UserPoolId output");
	const quoted = ownerEmail.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const { Users = [] } = await new CognitoIdentityProviderClient({}).send(
		new ListUsersCommand({ UserPoolId: outputs.UserPoolId, Filter: `email = "${quoted}"`, Limit: 2 }),
	);
	const attr = (name: string) => Users[0]?.Attributes?.find((a) => a.Name === name)?.Value;
	if (Users.length !== 1 || !attr("sub")) throw new Error(`expected exactly one Cognito user with email ${ownerEmail}, found ${Users.length}`);
	owner = { sub: attr("sub") as string, email: attr("email") ?? ownerEmail };
}

const rows = await scanKeyIndex();
const profiles = await scanProfiles();
const plan = planMigration(rows, profiles, owner);
const counts = await applyPlan(plan, { rows, profiles });

const pending = rows.filter((r) => !r.org_id).length;
console.error(`Key index: ${rows.length} rows, ${pending} in the old shape.`);
console.error(`Wrote ${counts.profiles} profiles, ${counts.members} owner memberships, ${counts.keys} key records, ${counts.index} index rows.`);
if (counts.retired > 0) console.error(`Retired ${counts.retired} keys of orgs that are deleting, deleted or suspended (rewritten as revoked).`);
if (counts.stale > 0) console.error(`Skipped ${counts.stale} rows that changed during the run: run it again to pick them up.`);
if (pending === 0 && counts.members === 0) console.error("Nothing to migrate.");
