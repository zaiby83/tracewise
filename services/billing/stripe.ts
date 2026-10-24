import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";
import { modeOfKey, type StripeMode } from "./mode";

interface StripeSecret {
	secret_key: string;
	webhook_secret: string;
}

const secrets = new SecretsManagerClient({});

// Re-read every 5 minutes, so keys put in the secret are picked up without a redeploy. A failed read is
// dropped so the next call retries, and a failed re-read falls back to the last good value rather than
// failing requests over a Secrets Manager blip.
const SECRET_TTL_MS = 5 * 60_000;
// Forced re-reads (the webhook's, on a signature mismatch) are spaced out, so a flood of forged requests
// can't become a flood of Secrets Manager calls.
const MIN_FORCED_REFRESH_MS = 30_000;
let cached: { value: Promise<StripeSecret>; until: number } | undefined;
let lastGood: StripeSecret | undefined;
let lastForced = -Infinity;
let client: { key: string; stripe: Stripe } | undefined;

async function loadSecret(arn: string): Promise<StripeSecret> {
	const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
	// Error text names the field, never the value: these end up in CloudWatch.
	if (!res.SecretString) throw new Error("Stripe secret has no SecretString");
	let parsed: Partial<StripeSecret> | null;
	try {
		parsed = JSON.parse(res.SecretString);
	} catch {
		// V8's own parse error quotes a snippet of the input, which here would be the key.
		throw new Error("Stripe secret is not valid JSON");
	}
	if (!parsed?.secret_key || !parsed.webhook_secret) throw new Error("Stripe secret must hold secret_key and webhook_secret");
	return { secret_key: parsed.secret_key, webhook_secret: parsed.webhook_secret };
}

function readSecret(): Promise<StripeSecret> {
	const arn = process.env.STRIPE_SECRET_ARN;
	if (!arn) return Promise.reject(new Error("STRIPE_SECRET_ARN is not set"));
	const now = Date.now();
	if (!cached || now >= cached.until) {
		const entry = { value: loadSecret(arn), until: now + SECRET_TTL_MS };
		entry.value = entry.value.then(
			(s) => {
				lastGood = s;
				return s;
			},
			(e: unknown) => {
				if (cached === entry) cached = undefined;
				if (lastGood) return lastGood;
				throw e;
			},
		);
		cached = entry;
	}
	return cached.value;
}

// Drops the cached secret so the next read goes to Secrets Manager. False when a forced re-read
// already happened in the last 30 seconds, and nothing was dropped.
export function refreshStripeSecret(): boolean {
	const now = Date.now();
	if (now - lastForced < MIN_FORCED_REFRESH_MS) return false;
	lastForced = now;
	cached = undefined;
	return true;
}

// STRIPE_SECRET_KEY is for operator scripts only; Lambdas get the ARN and never the raw key.
export async function getStripe(): Promise<Stripe> {
	const key = process.env.STRIPE_SECRET_KEY || (await readSecret()).secret_key;
	// The SDK's own pinned version, so request shapes match the typings we compile against.
	client = client?.key === key ? client : { key, stripe: new Stripe(key, { apiVersion: Stripe.API_VERSION, maxNetworkRetries: 2, timeout: 10_000 }) };
	return client.stripe;
}

export async function getWebhookSecret(): Promise<string> {
	return process.env.STRIPE_WEBHOOK_SECRET || (await readSecret()).webhook_secret;
}

// Which Stripe mode the configured key talks to.
export async function stripeMode(): Promise<StripeMode> {
	return modeOfKey(process.env.STRIPE_SECRET_KEY || (await readSecret()).secret_key);
}

// The Customer Portal configuration `stripe-setup` maintains, found by its metadata tag so no
// id has to be configured. Cached per instance once found; a miss is not cached, so a
// configuration created after a cold start is picked up.
export const PORTAL_METADATA = { tracewise: "portal" } as const;
let portalConfigId: string | undefined;

export async function findPortalConfigId(stripe: Stripe): Promise<string | null> {
	if (portalConfigId) return portalConfigId;
	const configs = (await stripe.billingPortal.configurations.list({ active: true, limit: 100 })).data;
	portalConfigId = configs.find((c) => c.metadata?.tracewise === PORTAL_METADATA.tracewise)?.id;
	return portalConfigId ?? null;
}
