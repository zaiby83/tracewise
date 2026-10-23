// End-to-end check of paid plans against a deployed stack, in Stripe TEST mode only. It makes a
// Cognito test user and an org, puts the org on a Team subscription (a customer on a Stripe test
// clock), and checks that the webhook moved the org to Team, ingest counts events, the meter
// reports them to Stripe, the period-end invoice carries the base and metered lines, and a
// cancellation puts the org back on Free. Everything it makes is removed afterwards.
//
// Needs: the stack deployed with the smoke client (see smoke-selfserve.ts), the Stripe webhook
// registered at the StripeWebhookUrl output, `stripe-setup` run in test mode, and your AWS
// credentials (Cognito admin, Accounts and Quotas tables).
// Usage: STRIPE_SECRET_KEY=sk_test_... pnpm exec tsx scripts/smoke-billing.ts [--overage]
import {
	AdminCreateUserCommand,
	AdminDeleteUserCommand,
	AdminInitiateAuthCommand,
	AdminSetUserPasswordCommand,
	CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { PLANS } from "../services/billing/plans";
import { clampTimestamp, METER_EVENT_NAME, periodKey, reportOrgUsage } from "../services/billing/meter";
import { getStripe } from "../services/billing/stripe";
import { getBilling, linkCustomer } from "../services/billing/subscriptions";
import { expectedMeteredCents, SMOKE_BILLING_USAGE, TEAM_BASE_CENTS, validateSmokeArgs } from "./lib/smoke-billing";
import { stackOutputs } from "./lib/stack";

// Everything below the argument check touches the network, so a wrong invocation stops here.
const args = validateSmokeArgs(process.argv.slice(2), process.env);
if (!args.ok) {
	(args.help ? console.log : console.error)(args.message);
	process.exit(args.help ? 0 : 1);
}
const { overage } = args;

const outputs = await stackOutputs().catch((e: unknown) => {
	console.error(`could not read the Tracewise stack: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
const missing = ["UserPoolId", "SmokeClientId", "DashboardUrl", "QuotasTable"].filter((k) => !outputs[k]);
if (missing.length > 0) {
	console.error(`stack outputs missing: ${missing.join(", ")}`);
	console.error(SMOKE_BILLING_USAGE);
	process.exit(1);
}
const { UserPoolId, SmokeClientId, DashboardUrl: url } = outputs as { UserPoolId: string; SmokeClientId: string; DashboardUrl: string };

const runId = crypto.randomUUID().slice(0, 8);
const email = `smoke-billing-${runId}@example.com`;
const orgName = `smoke-billing-${runId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
	if (!ok) failures++;
};

const cognito = new CognitoIdentityProviderClient({});
// Cognito's password policy asks for length, upper, lower, digits and a symbol. Never printed.
const password = () => `Tw-${crypto.randomUUID()}-aA1!`;

async function signUp(): Promise<string> {
	const pw = password();
	await cognito.send(
		new AdminCreateUserCommand({
			UserPoolId,
			Username: email,
			UserAttributes: [
				{ Name: "email", Value: email },
				{ Name: "email_verified", Value: "true" },
			],
			// No email goes out: the test user is a mailbox nobody owns.
			MessageAction: "SUPPRESS",
		}),
	);
	await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: email, Password: pw, Permanent: true }));
	const { AuthenticationResult } = await cognito.send(
		new AdminInitiateAuthCommand({ UserPoolId, ClientId: SmokeClientId, AuthFlow: "ADMIN_USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: pw } }),
	);
	if (!AuthenticationResult?.IdToken) throw new Error("no ID token for the test user");
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

// Polls until `done` returns a value, or gives up after `ms`.
async function waitFor<T>(ms: number, every: number, done: () => Promise<T | undefined>): Promise<T | undefined> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await done();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) return undefined;
		await sleep(every);
	}
}

// Sends `count` events with the org's key, 100 at a time. A per-minute 429 waits for the next window,
// which is what paces --overage; anything else that isn't a 202 fails the run.
async function ingest(key: string, count: number): Promise<number> {
	let sent = 0;
	while (sent < count) {
		const n = Math.min(100, count - sent);
		const res = await fetch(`${url}/v1/traces`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({
				events: Array.from({ length: n }, () => ({ event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "smoke-model", input: "i", output: "o", latency_ms: 1 })),
			}),
		});
		if (res.status === 429 && res.headers.get("x-tracewise-limit") === "minute") {
			await sleep(5_000);
			continue;
		}
		if (res.status !== 202) throw new Error(`ingest answered ${res.status} after ${sent} events`);
		sent += n;
	}
	return sent;
}

const planOf = async (token: string, orgId: string) => (await api("GET", `/v1/orgs/${orgId}/billing`, token)).body?.plan as string | undefined;

let token = "";
let orgId = "";
let userCreated = false;
let clockId = "";
const stripe = await getStripe();

try {
	// 1. A user and an org, through the console API as the browser would.
	token = await signUp();
	userCreated = true;
	const created = await api("POST", "/v1/orgs", token, { name: orgName });
	orgId = created.body?.org?.org_id ?? "";
	const secret: string = created.body?.key?.secret ?? "";
	check("test user and org created", created.status === 201 && Boolean(orgId) && secret.startsWith("tw_"), `status ${created.status}`);
	if (!orgId || !secret) throw new Error("no org to test against");

	// 2. A customer on a test clock with a card that always succeeds, tied to the org, and a Team subscription.
	const prices = (await stripe.prices.list({ lookup_keys: [PLANS.team.stripe!.base, PLANS.team.stripe!.metered], active: true })).data;
	const baseId = prices.find((p) => p.lookup_key === PLANS.team.stripe!.base)?.id;
	const meteredId = prices.find((p) => p.lookup_key === PLANS.team.stripe!.metered)?.id;
	if (!baseId || !meteredId) throw new Error("team prices not found: run stripe-setup in test mode first");

	const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `smoke-billing-${runId}` });
	clockId = clock.id;
	const customer = await stripe.customers.create({ email, test_clock: clock.id, metadata: { org_id: orgId } });
	const card = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
	await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card.id } });
	// Written directly, as the console does at Checkout, so the webhook can find the org from the customer.
	await linkCustomer(orgId, customer.id);
	const subscription = await stripe.subscriptions.create({
		customer: customer.id,
		items: [{ price: baseId }, { price: meteredId }],
		default_payment_method: card.id,
		metadata: { org_id: orgId },
	});
	check("test clock, customer and Team subscription created", subscription.status === "active", `status ${subscription.status}`);

	// 3. The webhook moves the org to Team: this is the live proof that signature checks, the secret and the route all work.
	const team = await waitFor(60_000, 2_000, async () => ((await planOf(token, orgId)) === "team" ? true : undefined));
	check("webhook moved the org to Team within 60 s", team === true, `plan ${await planOf(token, orgId)}`);
	if (!team) throw new Error("the webhook did not apply the subscription: check the webhook endpoint, its signing secret and the BillingWebhook logs");

	// 4. Events through the org's own key.
	const events = await ingest(secret, 25);
	check("ingest accepted 25 events", events === 25);

	// 5. The meter, run here with the operator's credentials rather than waiting for the hourly schedule.
	const billing = await getBilling(orgId);
	if (!billing?.current_period_start || !billing.current_period_end) throw new Error("BILLING has no period");
	const periodStart = periodKey(billing.current_period_start);
	const periodStartSec = Math.floor(Date.parse(billing.current_period_start) / 1000);
	const reported = await reportOrgUsage(billing, { periodStart, timestamp: clampTimestamp(Date.now() / 1000, billing.current_period_end) });
	check("meter reported the ingested events", reported.sent === events, `${reported.sent} sent`);

	// 6. Stripe aggregates meter events asynchronously, so poll its summary for the customer.
	const meter = (await stripe.billing.meters.list({ status: "active", limit: 100 })).data.find((m) => m.event_name === METER_EVENT_NAME);
	if (!meter) throw new Error(`no active Stripe meter named ${METER_EVENT_NAME}`);
	const summed = async () => {
		const end = Math.ceil(Date.now() / 60_000) * 60 + 60;
		const { data } = await stripe.billing.meters.listEventSummaries(meter.id, { customer: customer.id, start_time: Math.floor(periodStartSec / 60) * 60, end_time: end });
		return data.reduce((total, s) => total + s.aggregated_value, 0);
	};
	const seen = await waitFor(90_000, 5_000, async () => ((await summed()) === events ? events : undefined));
	check("Stripe's meter summary matches the ingested count", seen === events, `${await summed()} of ${events}`);

	// 7. Optional: really cross the included allowance, so the overage line has something to price.
	let total = events;
	if (overage) {
		console.log("--overage: ingesting 500,001 events, paced by the per-minute limit (about 90 minutes)...");
		total += await ingest(secret, PLANS.team.included_events + 1 - events);
		const again = await reportOrgUsage((await getBilling(orgId))!, { periodStart, timestamp: clampTimestamp(Date.now() / 1000, billing.current_period_end) });
		check("meter reported the rest", again.sent === total - events, `${again.sent} sent`);
	}

	// 8. Move the clock past the period end, plus the hour Stripe waits before it finalizes the invoice.
	const target = Math.floor(Date.parse(billing.current_period_end) / 1000) + 2 * 3600;
	await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: target });
	const ready = await waitFor(5 * 60_000, 5_000, async () => ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready" ? true : undefined));
	check("test clock advanced past the period end", ready === true);

	// 9. The period-end invoice: the base price, and usage priced on the graduated tiers.
	const invoice = await waitFor(60_000, 3_000, async () => {
		const { data } = await stripe.invoices.list({ customer: customer.id, limit: 10 });
		return data.find((i) => i.billing_reason === "subscription_cycle" && (i.status === "open" || i.status === "paid"));
	});
	check("period-end invoice was finalized", Boolean(invoice), invoice ? `status ${invoice.status}` : "none");
	if (invoice) {
		const lines = (await stripe.invoices.listLineItems(invoice.id, { limit: 100 })).data;
		const priceOf = (l: (typeof lines)[number]) => {
			const p = l.pricing?.price_details?.price;
			return typeof p === "string" ? p : p?.id;
		};
		const base = lines.find((l) => priceOf(l) === baseId);
		const metered = lines.find((l) => priceOf(l) === meteredId);
		check("invoice has the Team base line ($29)", base?.amount === TEAM_BASE_CENTS, `${base?.amount ?? "missing"} cents`);
		const wantCents = expectedMeteredCents(PLANS.team, total);
		check(
			"invoice metered line matches the reported quantity at the tier price",
			!!metered && Number(metered.quantity) === total && metered.amount === wantCents,
			`quantity ${metered?.quantity ?? "missing"}, ${metered?.amount ?? "missing"} cents, expected ${total} and ${wantCents} cents`,
		);
		// Stripe rounds each line to whole cents, so the first event over the allowance ($0.00005) shows as 0 cents with a quantity.
		if (overage) check("overage is on the invoice's metered line", Number(metered?.quantity) === PLANS.team.included_events + 1);
	}

	// 10. Cancel, and the webhook puts the org back on Free.
	await stripe.subscriptions.cancel(subscription.id);
	const free = await waitFor(60_000, 2_000, async () => ((await planOf(token, orgId)) === "free" ? true : undefined));
	check("cancellation returned the org to Free within 60 s", free === true, `plan ${await planOf(token, orgId)}`);
} catch (e) {
	check("script ran to completion", false, e instanceof Error ? e.message : String(e));
} finally {
	// Deleting the clock deletes its customer and subscription with it.
	if (clockId) await stripe.testHelpers.testClocks.del(clockId).catch((e: unknown) => console.error(`could not delete test clock ${clockId}: ${e instanceof Error ? e.message : String(e)}`));
	// Asks for the org's deletion without waiting: the deleter finishes it in the background.
	if (orgId && token) await api("DELETE", `/v1/orgs/${orgId}`, token, { confirm_name: orgName }).catch(() => undefined);
	if (userCreated) await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: email })).catch(() => undefined);
}

process.exit(failures ? 1 : 0);
