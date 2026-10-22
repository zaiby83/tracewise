// Compiles the design system's tokens (design/tokens.json, the same file the Tracewise
// design system publishes) into dashboard/tokens.css. Run after changing a token.
// Usage: pnpm tokens
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Value = string | Record<string, string>;
interface Token {
	name: string;
	value: Value;
}
interface Tokens {
	color: { themes: { id: string }[]; tokens: Token[] };
	type: { families: Record<string, string> };
	shadow: { tokens: Token[] };
	[family: string]: unknown;
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const tokensPath = path.join(root, "design/tokens.json");
export const cssPath = path.join(root, "dashboard/tokens.css");

// Families that hold one value for every theme, in the order they're declared.
const PLAIN = ["spacing", "radius", "layout", "opacity", "zIndex"];

export function buildTokensCss(tokens: Tokens): string {
	const [light, dark] = tokens.color.themes.map((t) => t.id);
	if (!light || !dark) throw new Error("tokens.json needs a light and a dark theme");
	const themed = [...tokens.color.tokens, ...tokens.shadow.tokens];
	const valueIn = (v: Value, theme: string) => (typeof v === "string" ? v : (v[theme] ?? v[light]));
	const decl = (name: string, value: string) => `\t--${name}: ${value};`;

	const lightBlock = [
		"\tcolor-scheme: light;",
		...themed.map((t) => decl(t.name, valueIn(t.value, light) as string)),
		...PLAIN.flatMap((f) => (tokens[f] as { tokens: Token[] }).tokens.map((t) => decl(t.name, t.value as string))),
		...Object.entries(tokens.type.families).map(([k, stack]) => decl(`font-${k}`, stack)),
	];
	// Dark only redeclares what differs from light.
	const darkBlock = [
		"\tcolor-scheme: dark;",
		...themed.filter((t) => typeof t.value !== "string" && t.value[dark] && t.value[dark] !== t.value[light]).map((t) => decl(t.name, valueIn(t.value, dark) as string)),
	];
	const indent = (lines: string[]) => lines.map((l) => `\t${l}`);

	return [
		"/* Tracewise tokens, generated from design/tokens.json by scripts/build-tokens.ts. Don't edit by hand. */",
		"/* Light by default; dark from the OS setting unless the viewer picked light, or from an explicit dark choice. */",
		":root {",
		...lightBlock,
		"}",
		"@media (prefers-color-scheme: dark) {",
		'\t:root:not([data-theme="light"]) {',
		...indent(darkBlock),
		"\t}",
		"}",
		':root[data-theme="dark"] {',
		...darkBlock,
		"}",
		"",
	].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(cssPath, buildTokensCss(JSON.parse(readFileSync(tokensPath, "utf8"))));
	console.log(`Wrote ${path.relative(root, cssPath)}`);
}
