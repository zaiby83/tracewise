import { describe, expect, it } from "vitest";
import { FREE_LIMITS } from "../services/shared/accounts";
import { curlQuickstart } from "../dashboard/console/views/overview.js";
import { usageRows } from "../dashboard/console/views/usage.js";

describe("console view helpers", () => {
	it("builds a working curl quickstart", () => {
		const c = curlQuickstart("https://d1.cloudfront.net", "tw_x");
		expect(c).toContain('-X POST "https://d1.cloudfront.net/v1/traces"');
		expect(c).toContain("authorization: Bearer tw_x");
		expect(c).toMatch(/"event_id":"[0-9a-f-]{36}"/);
	});

	it("puts a fresh UUID and timestamp in each quickstart", () => {
		const a = curlQuickstart("https://x.example", "k");
		const b = curlQuickstart("https://x.example", "k");
		expect(a).toMatch(/"ts":"\d{4}-\d\d-\d\dT[\d:.]+Z"/);
		expect(a).not.toBe(b);
	});

	it("lists usage against every limit, with what happens at the cap", () => {
		const rows = usageRows({ limits: FREE_LIMITS, used: { events_this_minute: 1, events_today: 2, analytics_queries_today: 3, eval_samples_last_night: 4, keys: 1, members: 1, pending_invites: 0 } });
		expect(rows.map((r) => r.label)).toEqual(["Events this minute", "Events today", "Analytics queries today", "Eval samples last night", "Keys", "Members", "Pending invites"]);
		expect(rows[1]).toMatchObject({ used: 2, limit: 50_000 });
		expect(rows[1]!.note).toBe("Ingest returns 429 until UTC midnight");
		expect(rows.map((r) => r.limit)).toEqual([600, 50_000, 200, 20, 10, 5, 10]);
		expect(rows.every((r) => r.note.length > 0)).toBe(true);
	});
});
