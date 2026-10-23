import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

interface StripeSecret {
	secret_key: string;
	webhook_secret: string;
}

const secrets = new SecretsManagerClient({});

// Read once per Lambda instance. A failed read is dropped so the next call retries instead of
// pinning the instance to a rejected promise until it is recycled.
let secret: Promise<StripeSecret> | undefined;
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
	if (!secret) {
		const pending = loadSecret(arn);
		secret = pending;
		pending.catch(() => {
			if (secret === pending) secret = undefined;
		});
	}
	return secret;
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
