import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records constructor arguments, so the tests can see the key and options without a network call.
vi.mock("stripe", () => ({
	default: class FakeStripe {
		static API_VERSION = "2026-09-30.endive";
		constructor(
			readonly key: string,
			readonly config: Record<string, unknown>,
		) {}
	},
}));

const SECRET = { secret_key: "sk_test_from_secrets_manager", webhook_secret: "whsec_from_secrets_manager" };
const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:tracewise/stripe-AbCdEf";

// The module caches per instance, so each test imports a fresh copy.
const load = async () => {
	vi.resetModules();
	return import("../services/billing/stripe");
};

describe("stripe client and secret access", () => {
	let send: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		vi.stubEnv("STRIPE_SECRET_KEY", "");
		vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
		vi.stubEnv("STRIPE_SECRET_ARN", ARN);
		send = vi.spyOn(SecretsManagerClient.prototype, "send").mockResolvedValue({ SecretString: JSON.stringify(SECRET) } as never);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("reads the Stripe secret once per instance", async () => {
		const { getStripe, getWebhookSecret } = await load();
		const a = await getStripe();
		const b = await getStripe();
		expect(await getWebhookSecret()).toBe(SECRET.webhook_secret);
		expect(a).toBe(b);
		expect(send).toHaveBeenCalledTimes(1);
		const command = send.mock.calls[0]![0] as GetSecretValueCommand;
		expect(command).toBeInstanceOf(GetSecretValueCommand);
		expect(command.input.SecretId).toBe(ARN);
	});

	it("builds the client with the secret key, a pinned api version, retries and a timeout", async () => {
		const { getStripe } = await load();
		const stripe = (await getStripe()) as unknown as { key: string; config: unknown };
		expect(stripe.key).toBe(SECRET.secret_key);
		expect(stripe.config).toEqual({ apiVersion: "2026-09-30.endive", maxNetworkRetries: 2, timeout: 10_000 });
	});

	it("uses STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET without touching Secrets Manager when they are set", async () => {
		vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_from_env");
		vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_from_env");
		vi.stubEnv("STRIPE_SECRET_ARN", "");
		const { getStripe, getWebhookSecret } = await load();
		expect(((await getStripe()) as unknown as { key: string }).key).toBe("sk_test_from_env");
		expect(await getWebhookSecret()).toBe("whsec_from_env");
		expect(send).not.toHaveBeenCalled();
	});

	it("fails clearly when neither the env key nor the secret ARN is set", async () => {
		vi.stubEnv("STRIPE_SECRET_ARN", "");
		const { getStripe, getWebhookSecret } = await load();
		await expect(getStripe()).rejects.toThrow(/STRIPE_SECRET_ARN/);
		await expect(getWebhookSecret()).rejects.toThrow(/STRIPE_SECRET_ARN/);
		expect(send).not.toHaveBeenCalled();
	});

	it("retries the read after a failure instead of caching the rejection", async () => {
		send.mockRejectedValueOnce(new Error("throttled") as never);
		const { getStripe } = await load();
		await expect(getStripe()).rejects.toThrow("throttled");
		await getStripe();
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("rejects a secret missing a field without echoing its contents", async () => {
		send.mockResolvedValue({ SecretString: JSON.stringify({ secret_key: "sk_test_leaky" }) } as never);
		const { getStripe } = await load();
		const error = await getStripe().catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/secret_key and webhook_secret/);
		expect((error as Error).message).not.toContain("sk_test_leaky");
	});

	it("rejects a secret that is not JSON without quoting any of it", async () => {
		send.mockResolvedValue({ SecretString: "sk_test_rawkeynotjson" } as never);
		const { getStripe } = await load();
		const error = (await getStripe().catch((e: Error) => e)) as Error;
		expect(error.message).toBe("Stripe secret is not valid JSON");
		expect(error.message).not.toContain("rawkeynotjson");
	});

	it("rejects a secret that is JSON but not an object", async () => {
		send.mockResolvedValue({ SecretString: "null" } as never);
		const { getStripe } = await load();
		await expect(getStripe()).rejects.toThrow(/secret_key and webhook_secret/);
	});
});

describe("findPortalConfigId", () => {
	const stripeWith = (data: unknown[]) => {
		const list = vi.fn().mockResolvedValue({ data });
		return { stripe: { billingPortal: { configurations: { list } } } as never, list };
	};

	it("returns the configuration tagged tracewise: portal, and caches it", async () => {
		const { findPortalConfigId } = await load();
		const { stripe, list } = stripeWith([
			{ id: "bpc_other", metadata: null },
			{ id: "bpc_legacy", metadata: { tracewise: "plan-switching" } },
			{ id: "bpc_ours", metadata: { tracewise: "portal" } },
		]);
		expect(await findPortalConfigId(stripe)).toBe("bpc_ours");
		expect(await findPortalConfigId(stripe)).toBe("bpc_ours");
		expect(list).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
	});

	it("returns null when none is tagged, and looks again next time", async () => {
		const { findPortalConfigId } = await load();
		const none = stripeWith([{ id: "bpc_other", metadata: {} }]);
		expect(await findPortalConfigId(none.stripe)).toBeNull();
		const some = stripeWith([{ id: "bpc_ours", metadata: { tracewise: "portal" } }]);
		expect(await findPortalConfigId(some.stripe)).toBe("bpc_ours");
	});
});
