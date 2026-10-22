// End-to-end check of self-serve accounts against a deployed stack: two Cognito test users, an
// org, ingest (and the key's last_used_at stamp), the trace query, an invite, a permission check,
// key revocation and org deletion down to the tombstone, the last hot-table item and the last
// object in the lake. The stack must be deployed with the smoke client:
//   TRACEWISE_ALARM_EMAIL=you@example.com TRACEWISE_DASHBOARD_KEY=<read-only key> pnpm run deploy --context smokeClient=true
// Keep both variables set on every redeploy: without them the demo gets an empty key and the alarm email is dropped.
// Needs the operator's AWS credentials (Cognito admin, s3:ListBucket on the lake, and DynamoDB
// reads on the Accounts and Traces tables).
// Usage: pnpm exec tsx scripts/smoke-selfserve.ts
import {
	AdminCreateUserCommand,
	AdminDeleteUserCommand,
	AdminInitiateAuthCommand,
	AdminSetUserPasswordCommand,
	CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Tracewise } from "../sdk/src/index";
import { getProfile } from "../services/shared/accounts";
import { ddb } from "../services/shared/ddb";
import { partitionsForDay } from "../services/shared/keys";
import { stackOutputs } from "./lib/stack";

if (process.argv.length > 2) {
	console.error("usage: pnpm exec tsx scripts/smoke-selfserve.ts");
	console.error("Deploy first with: TRACEWISE_ALARM_EMAIL=... TRACEWISE_DASHBOARD_KEY=... pnpm run deploy --context smokeClient=true");
	console.error("Set both variables on every redeploy, or the demo loses its key and the alarm email subscription is dropped.");
	console.error("Reads the stack outputs UserPoolId, SmokeClientId, DashboardUrl, LakeBucket, AccountsTable and TracesTable; takes no arguments.");
	process.exit(process.argv.some((a) => a === "-h" || a === "--help") ? 0 : 1);
}

// Everything is checked before the first write, so a stack without the smoke client fails here.
const outputs = await stackOutputs().catch((e: unknown) => {
	console.error(`could not read the Tracewise stack: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
const missing = ["UserPoolId", "SmokeClientId", "DashboardUrl", "LakeBucket", "TracesTable"].filter((k) => !outputs[k]);
if (missing.length > 0) {
	console.error(`stack outputs missing: ${missing.join(", ")}`);
	if (missing.includes("SmokeClientId")) {
		console.error("deploy with: TRACEWISE_ALARM_EMAIL=... TRACEWISE_DASHBOARD_KEY=... pnpm run deploy --context smokeClient=true");
		console.error("(set both on every redeploy, or the demo loses its key and the alarm email is dropped)");
	}
	process.exit(1);
}
// stackOutputs also pointed getProfile at the Accounts table.
const { UserPoolId, SmokeClientId, DashboardUrl: url, LakeBucket, TracesTable } = outputs as {
	UserPoolId: string;
	SmokeClientId: string;
	DashboardUrl: string;
	LakeBucket: string;
	TracesTable: string;
};

const runId = crypto.randomUUID().slice(0, 8);
const emails = { a: `smoke-${runId}-a@example.com`, b: `smoke-${runId}-b@example.com` };
const orgName = `smoke-${runId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures++;
};

const cognito = new CognitoIdentityProviderClient({});
const s3 = new S3Client({});

// Cognito's password policy asks for length, upper, lower, digits and a symbol. Never printed.
const password = () => `Tw-${crypto.randomUUID()}-aA1!`;

async function signUp(email: string): Promise<string> {
	const pw = password();
	await cognito.send(
		new AdminCreateUserCommand({
			UserPoolId,
			Username: email,
			UserAttributes: [
				{ Name: "email", Value: email },
				{ Name: "email_verified", Value: "true" },
			],
			// No email goes out: the test users are real mailboxes nobody owns.
			MessageAction: "SUPPRESS",
		}),
	);
	await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: email, Password: pw, Permanent: true }));
	const { AuthenticationResult } = await cognito.send(
		new AdminInitiateAuthCommand({
			UserPoolId,
			ClientId: SmokeClientId,
			AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
			AuthParameters: { USERNAME: email, PASSWORD: pw },
		}),
	);
	// The console sends the ID token: it carries the email claims and aud = client id.
	if (!AuthenticationResult?.IdToken) throw new Error(`no ID token for ${email}`);
	return AuthenticationResult.IdToken;
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`${url}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

const ingest = (key: string) =>
	fetch(`${url}/v1/traces`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({
			events: [{ event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "smoke-model", input: "i", output: "o", latency_ms: 1 }],
		}),
	});

async function lakeObjects(orgId: string): Promise<number> {
	const { KeyCount = 0 } = await s3.send(new ListObjectsV2Command({ Bucket: LakeBucket, Prefix: `traces/tenant_id=${orgId}/`, MaxKeys: 1 }));
	return KeyCount;
}

// Items left in the org's hot-table partitions for the given days, read directly with the
// operator's credentials (the API can't see a deleted org's data at all).
async function hotItems(orgId: string, days: string[]): Promise<number> {
	let count = 0;
	for (const pk of days.flatMap((d) => partitionsForDay(orgId, d))) {
		const { Count = 0 } = await ddb.send(
			new QueryCommand({ TableName: TracesTable, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, Select: "COUNT", ConsistentRead: true }),
		);
		count += Count;
	}
	return count;
}

let tokenA = "";
let tokenB = "";
let orgId = "";
let deleteRequested = false;

try {
	// 1. Two verified users, signed in without email or a browser.
	[tokenA, tokenB] = await Promise.all([signUp(emails.a), signUp(emails.b)]);
	check("test users created and signed in", Boolean(tokenA && tokenB));

	// 2. Create an org: the response carries the first key's secret, once.
	const created = await api("POST", "/v1/orgs", tokenA, { name: orgName });
	orgId = created.body?.org?.org_id ?? "";
	const secret: string = created.body?.key?.secret ?? "";
	check("org created with a first key", created.status === 201 && Boolean(orgId) && secret.startsWith("tw_"), `status ${created.status}`);
	if (!orgId || !secret) throw new Error("no org to test against");

	// 3. Ingest through the SDK, as an app would.
	const day = new Date().toISOString().slice(0, 10);
	const errors: unknown[] = [];
	const tw = new Tracewise({ apiKey: secret, endpoint: url, onError: (e) => errors.push(e) });
	for (let i = 0; i < 5; i++) tw.record({ model: "smoke-model", route: `smoke-${runId}`, input: `question ${i}`, output: `answer ${i}`, latency_ms: 100 + i });
	await tw.shutdown();
	check("SDK sent 5 events", errors.length === 0 && tw.dropped === 0, `${errors.length} errors`);

	// 4. They become queryable through the console's route (async pipeline, so poll).
	const deadline = Date.now() + 30_000;
	let seen = 0;
	while (Date.now() < deadline && seen < 5) {
		await sleep(1000);
		const res = await api("GET", `/v1/orgs/${orgId}/traces?day=${day}`, tokenA);
		seen = ((res.body?.traces ?? []) as { route?: string }[]).filter((t) => t.route === `smoke-${runId}`).length;
	}
	check("events queryable by the owner's session", seen === 5, `${seen} of 5 visible`);

	// 4b. Ingest stamped the key's last_used_at. The write is fire-and-forget and limited by an
	// IAM condition to pk, sk and last_used_at, so this is the live check of that condition.
	const stampDeadline = Date.now() + 20_000;
	let lastUsed: string | null = null;
	while (Date.now() < stampDeadline && !lastUsed) {
		const res = await api("GET", `/v1/orgs/${orgId}/keys`, tokenA);
		lastUsed = (res.body?.keys ?? [])[0]?.last_used_at ?? null;
		if (!lastUsed) await sleep(2000);
	}
	check("ingest stamped the key's last_used_at", Boolean(lastUsed), lastUsed ?? "still null");

	// 5. Invite B, accept as B. The link's last segment is the token.
	const invite = await api("POST", `/v1/orgs/${orgId}/invites`, tokenA, { email: emails.b, role: "member" });
	const inviteToken = String(invite.body?.link ?? "").split("/invite/")[1] ?? "";
	check("invite created", invite.status === 201 && inviteToken.length > 0, `status ${invite.status}`);
	const accepted = await api("POST", "/v1/invites/accept", tokenB, { token: inviteToken });
	check("invite accepted", accepted.status === 200 && accepted.body?.org_id === orgId, `status ${accepted.status}`);
	const listed = await api("GET", "/v1/orgs", tokenB);
	check("member sees the org", ((listed.body?.orgs ?? []) as { org_id: string }[]).some((o) => o.org_id === orgId));

	// 6. Members can't change settings.
	const patched = await api("PATCH", `/v1/orgs/${orgId}`, tokenB, { name: "hijacked" });
	check("member can't edit the org", patched.status === 403, `status ${patched.status}`);

	// 7. A revoked key stops working once the ingest function's one-minute key cache expires.
	const keys = await api("GET", `/v1/orgs/${orgId}/keys`, tokenA);
	const keyId = (keys.body?.keys ?? [])[0]?.key_id;
	const revoked = keyId ? await api("DELETE", `/v1/orgs/${orgId}/keys/${keyId}`, tokenA) : { status: 0 };
	check("key revoked", revoked.status === 200, `status ${revoked.status}`);
	await sleep(65_000);
	const after = await ingest(secret);
	check("revoked key rejected at ingest", after.status === 401, `status ${after.status}`);

	// 8. Delete the org, then wait for the deleter to finish: the tombstone is written by its
	// last phase, after the delayed sweep (15 minutes) has re-deleted late writes.
	const deleted = await api("DELETE", `/v1/orgs/${orgId}`, tokenA, { confirm_name: orgName });
	deleteRequested = deleted.status === 202;
	check("org deletion accepted", deleteRequested, `status ${deleted.status}`);
	const gone = Date.now() + 25 * 60_000;
	let profileStatus: string | undefined;
	const waitStart = Date.now();
	while (Date.now() < gone) {
		profileStatus = (await getProfile(orgId))?.status;
		if (profileStatus === "deleted") break;
		await sleep(30_000);
	}
	const waited = `after ${Math.round((Date.now() - waitStart) / 1000)} s`;
	check("deleter finished (profile tombstoned)", profileStatus === "deleted", `status ${profileStatus ?? "missing"}, ${waited}`);
	const status = (await api("GET", `/v1/orgs/${orgId}/traces?day=${day}`, tokenA)).status;
	check("org gone from the API", status === 404, `status ${status}`);
	const objects = await lakeObjects(orgId);
	check("lake prefix empty", objects === 0, `${objects} objects`);
	// The ingest day, and today too if the run crossed midnight UTC.
	const items = await hotItems(orgId, [...new Set([day, new Date().toISOString().slice(0, 10)])]);
	check("trace partitions empty", items === 0, `${items} items`);
} catch (e) {
	check("script ran to completion", false, e instanceof Error ? e.message : String(e));
} finally {
	// A failed run shouldn't leave an active org behind: ask for its deletion, best effort.
	if (orgId && !deleteRequested && tokenA) {
		await api("DELETE", `/v1/orgs/${orgId}`, tokenA, { confirm_name: orgName }).catch(() => undefined);
	}
	// 9. The test users never outlive the run.
	for (const email of Object.values(emails)) {
		await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: email })).catch(() => undefined);
	}
}

// 10. Any failure fails the run.
process.exit(failures ? 1 : 0);
