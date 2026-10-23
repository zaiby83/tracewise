// Moves every active free org onto the Free plan's current limits (a monthly cap, 2 members, 3
// keys, 2 pending invites) and 7-day retention for newly written traces. Custom and paid orgs
// are untouched. Safe to run again: it changes nothing that already matches, and each write is
// conditional on the org still being active and free.
// Usage: pnpm exec tsx scripts/apply-plan-limits.ts
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { k, type OrgProfile } from "../services/shared/accounts";
import { ddb } from "../services/shared/ddb";
import { planFreeUpgrade } from "./lib/plan-limits";
import { stackOutputs } from "./lib/stack";

if (process.argv.length > 2) {
	console.error("usage: pnpm exec tsx scripts/apply-plan-limits.ts");
	console.error("Takes no arguments. Reads the Tracewise stack's outputs and writes to the Accounts table with your AWS credentials.");
	process.exit(process.argv.some((a) => a === "-h" || a === "--help") ? 0 : 1);
}

await stackOutputs();

async function scanProfiles(): Promise<OrgProfile[]> {
	const items: OrgProfile[] = [];
	let startKey: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(
			new ScanCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				FilterExpression: "sk = :p",
				ExpressionAttributeValues: { ":p": "PROFILE" },
				ExclusiveStartKey: startKey,
			}),
		);
		items.push(...((page.Items ?? []) as OrgProfile[]));
		startKey = page.LastEvaluatedKey;
	} while (startKey);
	return items;
}

const profiles = await scanProfiles();
const counts = { scanned: profiles.length, updated: 0, current: 0, skipped: 0, raced: 0 };

for (const profile of profiles) {
	if (profile.plan !== "free" || profile.status !== "active") {
		counts.skipped++;
		continue;
	}
	const change = planFreeUpgrade(profile);
	if (!change) {
		counts.current++;
		continue;
	}
	try {
		await ddb.send(
			new UpdateCommand({
				TableName: process.env.ACCOUNTS_TABLE,
				Key: { pk: k.org(profile.org_id), sk: "PROFILE" },
				UpdateExpression: "SET limits = :limits, retention_days = :retention",
				// An org that upgraded, was made custom or was suspended since the scan keeps what it has.
				ConditionExpression: "#p = :free AND #s = :active",
				ExpressionAttributeNames: { "#p": "plan", "#s": "status" },
				ExpressionAttributeValues: { ":limits": change.limits, ":retention": change.retention_days, ":free": "free", ":active": "active" },
			}),
		);
		counts.updated++;
	} catch (e) {
		if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
		counts.raced++;
	}
}

console.error(`Scanned ${counts.scanned} profiles: ${counts.updated} free orgs updated, ${counts.current} already current, ${counts.skipped} not active free (left alone).`);
if (counts.raced > 0) console.error(`${counts.raced} orgs changed plan or status during the run and were skipped: run it again to re-check them.`);
