// How much of each plan limit is in use, and what happens at the cap.

import { el } from "../../shared/dom.js";
import { int } from "../../shared/format.js";
import { magnitude } from "../../shared/charts.js";
import { pageHead } from "../ui.js";

// One row per limit, in the order shown on screen.
export function usageRows({ limits, used }) {
	return [
		{ label: "Events this minute", used: used.events_this_minute, limit: limits.events_per_minute, note: "Ingest returns 429 until the next minute" },
		{ label: "Events today", used: used.events_today, limit: limits.events_per_day, note: "Ingest returns 429 until UTC midnight" },
		{ label: "Analytics queries today", used: used.analytics_queries_today, limit: limits.analytics_queries_per_day, note: "Analytics returns 429 until UTC midnight" },
		{ label: "Eval samples last night", used: used.eval_samples_last_night, limit: limits.eval_samples_per_night, note: "Only this many answers are scored each night" },
		{ label: "Keys", used: used.keys, limit: limits.max_keys, note: "Creating another key is refused until you revoke one" },
		{ label: "Members", used: used.members, limit: limits.max_members, note: "Invites are refused until someone leaves" },
		{ label: "Pending invites", used: used.pending_invites, limit: limits.max_pending_invites, note: "New invites are refused until some are accepted or revoked" },
	];
}

export async function render(root, ctx) {
	const usage = await ctx.api.get(`/v1/orgs/${ctx.org.org_id}/usage`);
	const rows = usageRows(usage).map((r) => {
		const share = r.limit > 0 ? r.used / r.limit : 0;
		return el(
			"li",
			{ class: share >= 1 ? "usage-row full" : "usage-row" },
			el("span", { class: "usage-label" }, r.label),
			el("span", { class: "usage-bar" }, magnitude(`${int.format(r.used)} of ${int.format(r.limit)}`, Math.min(1, share))),
			el("span", { class: "usage-note" }, r.note),
		);
	});
	root.replaceChildren(pageHead("Usage", "Your plan's limits. Daily counters reset at UTC midnight."), el("section", { class: "card" }, el("ul", { class: "usage" }, rows)));
}
