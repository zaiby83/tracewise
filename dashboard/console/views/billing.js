// Billing: the current plan and its usage, and (for owners) upgrading, switching plans, the
// spend cap and the Stripe portal. Members see the same numbers and none of the controls; the
// API refuses their changes anyway. Every value goes in as text through el().

import { el } from "../../shared/dom.js";
import { int } from "../../shared/format.js";
import { magnitude } from "../../shared/charts.js";
import { cardHead, confirmDialog, errorLine, pageHead, run, showError } from "../ui.js";

// The paid plans as the cards show them. A test compares these with PLANS in services/billing/plans.ts,
// so a price changed there fails until it is changed here too.
export const PLAN_DETAILS = {
	team: { name: "Team", price_usd: 29, included_events: 500_000, overage_per_100k_usd: 5, retention_days: 30, max_members: 10 },
	pro: { name: "Pro", price_usd: 199, included_events: 5_000_000, overage_per_100k_usd: 3, retention_days: 90, max_members: 50 },
};

const LABELS = { free: "Free", team: "Team", pro: "Pro", custom: "Custom" };
// What Stripe calls each subscription state, and how worried to look about it.
const STATUSES = {
	active: ["Active", "ok"],
	trialing: ["Trial", "ok"],
	past_due: ["Payment failed", "bad"],
	unpaid: ["Unpaid", "bad"],
	incomplete: ["Incomplete", "warn"],
	canceled: ["Canceled", "warn"],
};
// States in which the subscription can be switched to another plan (the API's own rule).
const SWITCHABLE = new Set(["active", "trialing", "past_due"]);

const POLL_MS = 5000;
const POLLS = 6;
const MAX_CAP_USD = 100_000;

const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
// Billing periods are UTC, and so is the date shown.
const day = (value) => new Date(value).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

// Whole cents, as the spend cap is stored.
export const roundCents = (n) => Math.round(n * 100) / 100;

const isPaid = (b) => b.plan === "team" || b.plan === "pro";

// The sentences the plan card shows. Pure, for tests.
export function billingSummary(b) {
	const events = int.format(b.events_this_period ?? 0);
	const usageLine = b.included_events == null ? `${events} events this period` : `${events} of ${int.format(b.included_events)} events this period`;
	const overageLine = b.estimated_overage_usd > 0 ? `Estimated overage so far: ${usd.format(b.estimated_overage_usd)}${typeof b.spend_cap_usd === "number" ? ` of your ${usd.format(b.spend_cap_usd)} spend cap` : ""}` : null;
	let renewalLine;
	if (b.plan === "free") renewalLine = "Usage resets on the first of each month (UTC).";
	else if (b.plan === "custom") renewalLine = "Managed by Tracewise.";
	else if (!b.current_period_end) renewalLine = "Renewal date to come.";
	else renewalLine = `${b.cancel_at_period_end ? "Cancels" : "Renews"} on ${day(b.current_period_end)}`;
	return { planLabel: LABELS[b.plan] ?? b.plan, usageLine, overageLine, renewalLine };
}

// Only ever follow a checkout or portal address over https.
function leaveTo(url) {
	let target = null;
	try {
		target = new URL(url);
	} catch {}
	if (target?.protocol !== "https:") throw new Error("Billing returned an unexpected address. Try again.");
	location.assign(target.href);
}

// One poller at a time: a newer one (another click, another visit) replaces the old.
let watching = 0;

export async function render(root, ctx) {
	const base = `/v1/orgs/${ctx.org.org_id}/billing`;
	const owner = ctx.org.role === "owner";
	let billing = await ctx.api.get(base);

	const notice = el("p", { class: "callout", role: "status", hidden: true });
	const body = el("div", { class: "billing" });
	const say = (text) => {
		notice.textContent = text ?? "";
		notice.hidden = !text;
	};
	let drawn = "";
	const draw = (b) => {
		billing = b;
		drawn = JSON.stringify(b);
		body.replaceChildren(planCard(b), ...(b.plan === "free" ? [planOptions()] : []), ...(owner && isPaid(b) ? [spendCapCard(b)] : []));
	};

	// Billing changes arrive by webhook, a few seconds after the action: look again every few seconds
	// until `done` says the screen has caught up, and give up after a bounded number of tries.
	function watch(done, finished) {
		const mine = ++watching;
		let tries = 0;
		const tick = async () => {
			if (mine !== watching || !root.isConnected || tries++ >= POLLS) return;
			try {
				const b = await ctx.api.get(base);
				if (mine !== watching || !root.isConnected) return;
				// Redraw only when something changed, so a half-typed cap or an error line survives a poll.
				if (JSON.stringify(b) !== drawn) draw(b);
				if (done(b)) {
					say(finished(b));
					ctx.refreshBanners?.();
					return;
				}
			} catch (err) {
				if (err.name === "AuthError") return;
			}
			if (tries >= POLLS) say("Still waiting for the update. Reload this page in a minute.");
			else setTimeout(tick, POLL_MS);
		};
		setTimeout(tick, POLL_MS);
	}

	// ---- Cards --------------------------------------------------------------------------

	function planCard(b) {
		const s = billingSummary(b);
		const status = STATUSES[b.status];
		const share = b.included_events > 0 ? Math.min(1, b.events_this_period / b.included_events) : 0;
		const actions = owner && isPaid(b) ? paidActions(b) : null;
		return el(
			"section",
			{ class: "card plan-card" },
			cardHead("Your plan"),
			el("div", { class: "plan-line" }, el("span", { class: "plan-name" }, s.planLabel), status ? el("span", { class: `pill ${status[1]}` }, el("span", { class: "dot", "aria-hidden": "true" }), status[0]) : null),
			el("p", { class: "plan-renewal" }, s.renewalLine),
			b.included_events == null ? el("p", { class: "plan-events" }, s.usageLine) : el("div", { class: share >= 1 ? (b.plan === "free" ? "plan-usage full" : "plan-usage over") : "plan-usage" }, magnitude(s.usageLine, share)),
			s.overageLine ? el("p", { class: "plan-overage" }, s.overageLine) : null,
			b.plan === "custom" ? el("p", {}, "Custom plan — contact us to change it.") : null,
			// Members can't set a cap, but the number is theirs to see.
			!owner && isPaid(b) ? el("dl", { class: "facts" }, el("dt", {}, "Spend cap"), el("dd", {}, typeof b.spend_cap_usd === "number" ? usd.format(b.spend_cap_usd) : "None")) : null,
			actions,
		);
	}

	// Switching between Team and Pro happens here, through our own route; the portal is for payment
	// methods, invoices and cancelling.
	function paidActions(b) {
		const other = b.plan === "team" ? "pro" : "team";
		const target = PLAN_DETAILS[other];
		const error = errorLine();
		const portal = el("button", { class: "button", type: "button" }, "Manage billing");
		portal.addEventListener("click", () =>
			run(portal, error, async () => {
				const { url } = await ctx.api.post(`${base}/portal`, {});
				leaveTo(url);
			}),
		);
		const buttons = [];
		if (SWITCHABLE.has(b.status)) {
			const swap = el("button", { class: "button primary", type: "button" }, `Switch to ${target.name}`);
			swap.addEventListener("click", async () => {
				const ok = await confirmDialog({
					title: `Switch to ${target.name}?`,
					body: `${target.name} is $${target.price_usd} a month with ${int.format(target.included_events)} events included. Stripe prorates the change on your next invoice.${other === "team" ? " Your members and keys are kept, but you can't add more than Team allows." : ""}`,
					confirm: `Switch to ${target.name}`,
					danger: false,
				});
				if (!ok) return;
				say("");
				const worked = await run(swap, error, async () => {
					await ctx.api.post(`${base}/change`, { plan: other });
				});
				if (!worked) return;
				say(`Switching to ${target.name}. Your plan updates within a minute.`);
				watch((next) => next.plan === other, (next) => `You're now on ${LABELS[next.plan]}.`);
			});
			buttons.push(swap);
		}
		return el("div", { class: "plan-actions" }, el("div", { class: "actions start" }, ...buttons, portal), el("p", { class: "hint" }, "Manage billing opens Stripe, for payment methods, invoices and cancelling."), error);
	}

	// Cap on overage spend: a number or empty (no cap). The API validates 0 to 100,000.
	function spendCapCard(b) {
		const error = errorLine();
		const input = el("input", { id: "spend-cap", name: "spend_cap_usd", type: "number", min: 0, max: MAX_CAP_USD, step: "0.01", inputmode: "decimal", placeholder: "No cap", value: b.spend_cap_usd ?? "", autocomplete: "off" });
		const save = el("button", { class: "button primary", type: "submit" }, "Save");
		const form = el(
			"form",
			{
				class: "form cap-form",
				onsubmit: (e) => {
					e.preventDefault();
					const raw = input.value.trim();
					const value = raw === "" ? null : roundCents(Number(raw));
					if (value !== null && (!Number.isFinite(value) || value < 0 || value > MAX_CAP_USD)) return showError(error, `Enter an amount from $0 to ${usd.format(MAX_CAP_USD).replace(".00", "")}, or leave it empty for no cap.`);
					say("");
					run(save, error, async () => {
						draw(await ctx.api.patch(base, { spend_cap_usd: value }));
						say(value === null ? "Spend cap removed." : `Spend cap set to ${usd.format(value)}.`);
						ctx.refreshBanners?.();
					});
				},
			},
			el("div", { class: "field" }, el("label", { for: "spend-cap" }, "Monthly spend cap (USD)"), el("div", { class: "cap-row" }, input, save), el("p", { class: "hint" }, "Overage is billed after the events your plan includes. Once overage reaches the cap, ingest returns 429 until the period ends. Leave it empty for no cap.")),
			error,
		);
		return el("section", { class: "card narrow" }, cardHead("Spend cap", "Limit what extra events can cost"), form);
	}

	// Free orgs choose a paid plan; Checkout is Stripe's page, and it sends them back here.
	function planOptions() {
		return el(
			"section",
			{ class: "plan-options", "aria-label": "Upgrade" },
			...Object.entries(PLAN_DETAILS).map(([id, p]) => {
				const error = errorLine();
				const upgrade = el("button", { class: "button primary", type: "button" }, `Upgrade to ${p.name}`);
				upgrade.addEventListener("click", () =>
					run(upgrade, error, async () => {
						let url;
						try {
							({ url } = await ctx.api.post(`${base}/checkout`, { plan: id }));
						} catch (err) {
							// Already subscribed means the webhook hasn't landed yet: wait for it rather than point at
							// a Manage billing button this screen doesn't show yet.
							if (err.status !== 409 || !/already subscribed/i.test(err.message)) throw err;
							say("Your subscription is being set up — this page will update shortly.");
							watch(isPaid, (b) => `Thanks, you're now on ${LABELS[b.plan]}.`);
							return;
						}
						leaveTo(url);
					}),
				);
				return el(
					"article",
					{ class: "card plan-option" },
					el("h2", {}, p.name),
					el("p", { class: "plan-price" }, `$${p.price_usd}`, el("span", {}, " per month")),
					el(
						"ul",
						{ class: "plan-points" },
						el("li", {}, `${int.format(p.included_events)} events included`),
						el("li", {}, `Then $${p.overage_per_100k_usd} per 100,000 events`),
						el("li", {}, `${p.retention_days} days of hot retention`),
						el("li", {}, `Up to ${p.max_members} members`),
					),
					owner ? el("div", { class: "actions start" }, upgrade) : el("p", { class: "hint" }, "Ask an owner of this organization to upgrade."),
					owner ? error : null,
				);
			}),
			el("p", { class: "hint plan-compare" }, el("a", { href: "../pricing.html" }, "Compare all plans")),
		);
	}

	// ---- Go -----------------------------------------------------------------------------

	root.replaceChildren(pageHead("Billing", owner ? "Your plan, usage and payment details." : "Your plan and usage. Only owners can change billing."), notice, body);
	draw(billing);

	if (ctx.param === "success") {
		// Back from Checkout: drop the query so a reload doesn't start the wait again.
		history.replaceState(null, "", `${location.pathname}${location.search}#/billing`);
		if (isPaid(billing)) say(`Thanks, you're now on ${LABELS[billing.plan]}.`);
		else {
			say("Thanks, your plan updates within a minute");
			watch(isPaid, (b) => `Thanks, you're now on ${LABELS[b.plan]}.`);
		}
	}
}
