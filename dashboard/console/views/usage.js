// How much of each plan limit is in use, and what happens at the cap.

import { el } from "../../shared/dom.js";
import { int } from "../../shared/format.js";
import { magnitude } from "../../shared/charts.js";
import { pageHead } from "../ui.js";

// What happens when the period's events run out: free stops, paid bills overage unless a spend cap
// (which sets monthly_events) stops it, and custom plans have no event limit.
function periodNote(plan, ceiling) {
	if (plan === "free") return "Ingest returns 429 until the period ends";
	if (plan === "custom") return "Your custom plan has no event limit";
	// Billing didn't load, so the plan is unknown: say only what the ceiling itself means.
	if (!plan) return ceiling === null ? "No event limit applies" : "Ingest returns 429 once this limit is reached";
	return ceiling === null ? "Paid plans keep accepting events and bill overage" : "Ingest returns 429 once your spend cap is reached";
}

// One row per limit, in the order shown on screen. `plan` and `included` come from billing: the
// usage endpoint knows the ceiling (monthly_events, null when there is none) but not what a paid
// plan includes. Without `plan` (billing failed to load) the rows still show, in plain wording.
// `state` is "full" where the limit is a hard stop that has been reached, and "over" where a paid
// plan is past its allowance but still accepting events (billed as overage).
/** @param {{ limits: any, used: any, plan?: string | null, included?: number | null }} args */
export function usageRows({ limits, used, plan = null, included = null }) {
	const ceiling = limits.monthly_events ?? null;
	// A paid plan with no ceiling never stops: past its allowance it is a bill, not a wall.
	const period = ceiling ?? included;
	const periodState = period !== null && used.events_this_period >= period ? (ceiling === null && plan !== "free" ? "over" : "full") : "";
	const rows = [
		{ label: "Events this minute", used: used.events_this_minute, limit: limits.events_per_minute, note: "Ingest returns 429 until the next minute" },
		{ label: "Events this period", used: used.events_this_period, limit: ceiling ?? included, note: periodNote(plan, ceiling) },
		{ label: "Analytics queries today", used: used.analytics_queries_today, limit: limits.analytics_queries_per_day, note: "Analytics returns 429 until UTC midnight" },
		{ label: "Eval samples last night", used: used.eval_samples_last_night, limit: limits.eval_samples_per_night, note: "Only this many answers are scored each night" },
		{ label: "Keys", used: used.keys, limit: limits.max_keys, note: "Creating another key is refused until you revoke one" },
		{ label: "Members", used: used.members, limit: limits.max_members, note: "Invites are refused until someone leaves" },
		{ label: "Pending invites", used: used.pending_invites, limit: limits.max_pending_invites, note: "New invites are refused until some are accepted or revoked" },
	];
	return rows.map((r, i) => ({ ...r, state: i === 1 ? periodState : r.limit > 0 && r.used >= r.limit ? "full" : "" }));
}

const periodSub = (period) => (period ? `Your plan's limits. This period runs ${period.start} to ${period.end} (UTC); daily counters reset at UTC midnight.` : "Your plan's limits. Daily counters reset at UTC midnight.");

export async function render(root, ctx) {
	const base = `/v1/orgs/${ctx.org.org_id}`;
	// The plan-aware wording is a bonus: if billing fails, the limits still show.
	const [usageResult, billingResult] = await Promise.allSettled([ctx.api.get(`${base}/usage`), ctx.api.get(`${base}/billing`)]);
	if (usageResult.status === "rejected") throw usageResult.reason;
	const usage = usageResult.value;
	const billing = billingResult.status === "fulfilled" ? billingResult.value : null;
	const rows = usageRows({ ...usage, plan: billing?.plan ?? null, included: billing?.included_events ?? null }).map((r) => {
		const share = r.limit > 0 ? r.used / r.limit : 0;
		return el(
			"li",
			{ class: r.state ? `usage-row ${r.state}` : "usage-row" },
			el("span", { class: "usage-label" }, r.label),
			el("span", { class: "usage-bar" }, magnitude(r.limit === null ? `${int.format(r.used)}, no limit` : `${int.format(r.used)} of ${int.format(r.limit)}`, Math.min(1, share))),
			el("span", { class: "usage-note" }, r.note),
		);
	});
	root.replaceChildren(pageHead("Usage", periodSub(usage.period)), el("section", { class: "card" }, el("ul", { class: "usage" }, rows)));
}
