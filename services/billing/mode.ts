// Stripe keeps test and live mode apart: customers, subscriptions and events from one are unknown to
// the other. Records we write carry `livemode` so that, once the secret holds a live key, whatever test
// mode left behind is treated as absent rather than sent to Stripe under the wrong key.
export type StripeMode = "test" | "live";

export const modeOfKey = (key: string): StripeMode => (/^[sr]k_live_/.test(key) ? "live" : "test");

// Records written before livemode was stored all came from test mode (paid plans had not gone live).
export const sameMode = (record: { livemode?: boolean | null }, mode: StripeMode): boolean => (record.livemode === true) === (mode === "live");
