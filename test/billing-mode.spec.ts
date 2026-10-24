import { describe, expect, it } from "vitest";
import { modeOfKey, sameMode } from "../services/billing/mode";

describe("Stripe mode", () => {
	it("reads the mode from the key's prefix", () => {
		expect(modeOfKey("sk_live_x")).toBe("live");
		expect(modeOfKey("rk_live_x")).toBe("live");
		expect(modeOfKey("sk_test_x")).toBe("test");
		expect(modeOfKey("rk_test_x")).toBe("test");
	});

	it("matches a record to the key's mode, reading a record from before livemode was stored as test mode", () => {
		expect(sameMode({ livemode: true }, "live")).toBe(true);
		expect(sameMode({ livemode: false }, "live")).toBe(false);
		expect(sameMode({}, "live")).toBe(false);
		expect(sameMode({ livemode: false }, "test")).toBe(true);
		expect(sameMode({}, "test")).toBe(true);
		expect(sameMode({ livemode: true }, "test")).toBe(false);
	});
});
