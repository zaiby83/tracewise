// Sets an org's limits and marks its plan custom (30-day retention, unless it was custom already). Unnamed limits keep their current value.
// Usage: pnpm exec tsx scripts/set-limits.ts "<org name or id>" key=value [key=value...]
import { updateProfile, findOrgByName } from "../services/console/store";
import { FREE_LIMITS, getProfile } from "../services/shared/accounts";
import { customPatch, parseLimitOverrides } from "./lib/limits";
import { stackOutputs } from "./lib/stack";

const [target, ...pairs] = process.argv.slice(2);
if (!target || pairs.length === 0) {
	console.error('usage: pnpm exec tsx scripts/set-limits.ts "<org name or id>" key=value [key=value...]');
	process.exit(1);
}

// Checked against the free defaults first, so a typo fails before anything touches AWS.
parseLimitOverrides(pairs, FREE_LIMITS);

await stackOutputs();
const org = (await getProfile(target)) ?? (await findOrgByName(target));
if (!org || org.status === "deleting" || org.status === "deleted") throw new Error(`no org named or numbered "${target}"`);

const limits = parseLimitOverrides(pairs, org.limits);
const updated = await updateProfile(org.org_id, customPatch(limits, org.plan));
console.error(`Updated "${updated.name}" (${updated.org_id}); plan is now ${updated.plan}.`);
console.log(JSON.stringify(updated.limits, null, 2));
