import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLANS } from "../services/billing/plans";

// A tiny reader for the page's one table: row label -> the four cell texts. The page is static
// and hand-written, so a regex is enough; anything it can't read fails the test below.
function parsePlansTable(html: string) {
	const table = /<table[^>]*id="plans"[^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
	const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").trim();
	const rows: Record<string, string[]> = {};
	let header: string[] = [];
	for (const [, row] of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const cells = [...row!.matchAll(/<t([hd])[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => text(m[2]!));
		if (row!.includes("<td")) rows[cells[0]!] = cells.slice(1);
		else header = cells.slice(1);
	}
	return { header, rows };
}

const int = new Intl.NumberFormat("en");
const html = readFileSync("dashboard/pricing.html", "utf8");
const { header, rows } = parsePlansTable(html);
const paidAndFree = ["free", "team", "pro"] as const;

describe("pricing page", () => {
	it("has the four plans, with the rows the plan table names", () => {
		expect(header).toEqual(["Free", "Team", "Pro", "Enterprise"]);
		expect(Object.keys(rows)).toEqual(["Price", "Included events", "Extra events", "Judge samples per night", "Hot retention", "Events per minute", "Members"]);
	});

	it("publishes the same prices and allowances the code enforces", () => {
		expect(rows.Price).toEqual(["$0", `$${PLANS.team.price_usd}/mo`, `$${PLANS.pro.price_usd}/mo`, "Contact us"]);
		expect(rows["Included events"]).toEqual([...paidAndFree.map((p) => int.format(PLANS[p].included_events)), "Custom"]);
		expect(rows["Extra events"]).toEqual(["—", `$${PLANS.team.overage_per_100k_usd} per 100k`, `$${PLANS.pro.overage_per_100k_usd} per 100k`, "Custom"]);
		expect(rows["Judge samples per night"]).toEqual([...paidAndFree.map((p) => int.format(PLANS[p].limits.eval_samples_per_night)), "Custom"]);
		expect(rows["Hot retention"]).toEqual([...paidAndFree.map((p) => `${PLANS[p].retention_days} days`), "Custom"]);
		expect(rows["Events per minute"]).toEqual([...paidAndFree.map((p) => int.format(PLANS[p].limits.events_per_minute)), "Custom"]);
		expect(rows.Members).toEqual([...paidAndFree.map((p) => int.format(PLANS[p].limits.max_members)), "Custom"]);
	});

	it("is static: no script, no inline style, monthly plans only", () => {
		expect(html).not.toMatch(/<script/i);
		expect(html).not.toMatch(/\sstyle\s*=/i);
		expect(html).not.toMatch(/annual|yearly/i);
	});
});
