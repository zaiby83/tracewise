import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTokensCss, cssPath, tokensPath } from "../scripts/build-tokens";

describe("design tokens", () => {
	it("dashboard/tokens.css matches design/tokens.json (run pnpm tokens)", () => {
		expect(readFileSync(cssPath, "utf8")).toBe(buildTokensCss(JSON.parse(readFileSync(tokensPath, "utf8"))));
	});
});
