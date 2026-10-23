# Billing and plans: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paid Team and Pro plans bought through Stripe Checkout. Metered overage is reported hourly to a Stripe Meter, a customer-set spend cap limits it, and each org's limits and retention follow its subscription automatically.

**Architecture:**
- **Plans:** `services/billing/plans.ts` is the single source of truth for plan allowances.
- **Ingest:** keeps a per-period event counter in the Quotas table and enforces a single `monthly_events` limit. That limit expresses the Free cap, unlimited paid plans, and spend caps alike.
- **Stripe sync:** a public webhook Lambda verifies Stripe events, re-fetches the subscription, and writes `PROFILE.plan`/`limits` plus a `BILLING` item.
- **Metering:** an hourly meter Lambda reports counter deltas to Stripe. There are no Stripe calls on the ingest path.
- **Console:** gets a Billing screen. The demo site gets a pricing page.

**Tech Stack:** TypeScript (strict, ESM), Node 22 Lambdas, AWS CDK v2 (aws-cdk-lib 2.274.0), DynamoDB, EventBridge Scheduler, Secrets Manager, the official `stripe` Node SDK, plain-JS console, vitest.

**Spec:** [docs/superpowers/specs/2026-10-23-billing-and-plans-design.md](../specs/2026-10-23-billing-and-plans-design.md). It builds on the self-serve spec and code on branch `self-serve-accounts`. Work on branch `billing`.

## Decisions made while planning

These refine the spec. Task 12 records them in the spec.

1. **`PROFILE` also carries `period_end`.** Ingest needs it for `retry-after`, and §9 already refers to it. §6's table lists only `period_start`.
2. **The stale-meter alarm works differently.** The meter publishes `MeterLastSuccessAgeMinutes = 0` on each fully successful run, and `BillingMeterStale` fires when no such datapoint arrives for 3 hours (missing data treated as breaching). A gauge that counts up would need a separate always-on timer, so this replaces it.
3. **`smoke-billing` doesn't override plans.** Its overage check is an opt-in `--overage` flag that really ingests 500,001 events, about $1.50 of AWS cost, so the test path never changes plan values. That replaces §13's `--included`.
4. **New free orgs get the new Free allowances right away** (2 members, 3 keys, 2 pending invites). Existing free orgs move only when `apply-plan-limits` runs.

## Global Constraints

**Plan values (exact):**

| | Free | Team | Pro |
|---|---|---|---|
| Price | $0 | $29/month | $199/month |
| Included events per period | 50,000 (hard cap) | 500,000 | 5,000,000 |
| Overage | none | $5 per 100,000 | $3 per 100,000 |
| Judge samples per night | 20 (shared free pool) | 100 | 500 |
| Hot retention | 7 days | 30 days | 90 days |
| Events per minute | 600 | 6,000 | 30,000 |
| Members / keys / pending invites | 2 / 3 / 2 | 10 / 20 / 10 | 50 / 100 / 50 |
| Analytics queries per day | 200 | 2,000 | 10,000 |

- **Monthly plans only.** No annual prices anywhere.
- **Stripe lookup keys:** `team_monthly`, `pro_monthly`, `team_metered`, `pro_metered`. Meter `event_name` is `tracewise_events`, with payload keys `stripe_customer_id` and `value`.
- **Metered price tiers (graduated):**

| Price | Events | Unit price |
|---|---|---|
| Team | 0–500,000 | $0 |
| Team | above 500,000 | `unit_amount_decimal: "0.005"` cents |
| Pro | 0–5,000,000 | $0 |
| Pro | above 5,000,000 | `unit_amount_decimal: "0.003"` cents |

- **`monthly_events`:**

| Plan | Value |
|---|---|
| free | 50,000 |
| paid, no spend cap | null |
| paid, spend cap | included + floor(cap ÷ overage_per_100k × 100,000) |
| custom | null |

- **Spend cap range:** 0–100,000 USD, or null.
- **Past-due grace:** 7 days, then Free limits.
- **Downgrades never delete data,** keys or members. They only block new creates over the limit.
- **No Stripe calls on the ingest, processor or query paths.** Ingest, processor, query, analytics and evals functions never get the Stripe secret.
- **Secrets:** A Secrets Manager secret (named by CDK, found through the `StripeSecretArn` output) holds JSON `{ "secret_key", "webhook_secret" }`, read once per cold start. Only the billing-webhook, billing-meter and console functions may read it. Never log keys, signatures or full event bodies.
- **429 headers:** `x-tracewise-limit: month` (free) or `spend_cap` (paid), with `retry-after` set to the seconds until the period ends. `minute` is unchanged. `day` goes away.
- **Constants:** `MAX_RETENTION_DAYS = 90`. The deleter covers day offsets −1 through `MAX_RETENTION_DAYS + 2`.
- **Free pool:** `GLOBAL_JUDGE_CALLS_PER_NIGHT` (2,000) applies to the free pool only. Paid and custom orgs get their own `eval_samples_per_night`. `SAMPLE_SIZE` defaults to 500.
- **New dependencies:** `stripe` (runtime) and `@aws-sdk/client-secrets-manager@3.1155.0` (runtime), each pinned to an exact version. Pick the newest `stripe` release at least 14 days old, and add both to `minimumReleaseAgeExclude` only if pnpm refuses.
- **Style:** tabs, short why-comments, `process.env` read at call time, per-test mock setup (no hook-level `mockReset` combined with persistent rejections). Commit messages are plain sentences ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Nothing runs against AWS or live Stripe during implementation.** Scripts are typechecked and unit-tested only.

## Review Focus

1. **Webhook body handling.** API Gateway HTTP API may send the body base64-encoded. The signature must be checked against the exact raw bytes, never re-serialized JSON. Covered by a test in Task 8.
2. **Duplicate and out-of-order webhooks.** A replayed event changes nothing. A stale `subscription.updated` arriving after `deleted` must not revive a plan, because the handler re-fetches the subscription. Covered by tests in Tasks 6 and 8.
3. **Period rollover.** When `period_start` advances, ingest must start a new counter and the meter must flush the old period first. No events may be lost or double-reported at the boundary. Covered by tests in Tasks 2 and 7.
4. **A spend cap set below current usage.** It must refuse ingest immediately, and `estimated_overage_usd` must never be negative. Covered by tests in Tasks 1 and 9.
5. **Downgrade with existing data.** Stored events keep their TTL. Keys and members over the new limit remain usable, but new creates get 409. Covered by tests in Tasks 6 and 9.

---

## File structure

| File | Responsibility |
|---|---|
| `services/billing/plans.ts` (new) | `PLANS`, `deriveMonthlyEvents`, `planForLookupKey`, `periodBounds` |
| `services/billing/stripe.ts` (new) | `getStripe()` and `getWebhookSecret()`, read from Secrets Manager and cached |
| `services/billing/subscriptions.ts` (new) | `applySubscription`, BILLING/CUSTOMER/EVENT items, state → plan mapping |
| `services/billing/meter.ts` (new) | `reportOrgUsage` (shared by the meter Lambda and the webhook flush) |
| `services/billing/webhook.ts` (new) | Lambda: verify, de-duplicate, dispatch |
| `services/billing/meter-handler.ts` (new) | Lambda: hourly scan, report, metric |
| `services/console/routes/billing.ts` (new) | 4 billing routes |
| `services/shared/accounts.ts`, `tenants.ts`, `schema.ts`, `keys.ts` (modify) | `Limits.monthly_events`, profile period fields, period counter, `retention_days` |
| `services/ingest/handler.ts`, `processor/handler.ts`, `deleter/handler.ts`, `evals/handlers.ts`, `console/store.ts`, `console/routes/usage.ts`, `console/route-keys.ts` (modify) | wire the above |
| `infra/lib/billing.ts` (new), `infra/lib/accounts.ts`, `infra/lib/tracewise-stack.ts` (modify) | secret, functions, schedule, routes, alarms, grants |
| `dashboard/console/views/billing.js` (new), `dashboard/console/app.js`, `views/usage.js`, `dashboard/pricing.html` (new), `dashboard/index.html` (modify) | UI |
| `scripts/stripe-setup.ts`, `scripts/apply-plan-limits.ts`, `scripts/smoke-billing.ts` (new); `scripts/lib/limits.ts`, `scripts/set-limits.ts` (modify) | operator tooling |

---

### Task 1: Plan table and the `monthly_events` limit

**Files:**
- Create: `services/billing/plans.ts`
- Modify: `services/shared/accounts.ts`, `services/console/store.ts`, `services/evals/handlers.ts`, `scripts/lib/limits.ts`, `scripts/set-limits.ts`, `scripts/lib/migrate.ts` (only if it references removed fields)
- Test: `test/plans.spec.ts` (new); update existing tests that reference `events_per_day` or `FREE_LIMITS`

**Interfaces:**
- Produces:
  - **`Limits`:** `events_per_day` is removed and `monthly_events: number | null` is added. The other fields are unchanged.
  - **`type PlanId = "free" | "team" | "pro"`**
  - **`interface Plan`:** `{ id: PlanId; name: string; price_usd: number; limits: Limits; retention_days: number; included_events: number; overage_per_100k_usd: number | null; stripe: { base: string; metered: string } | null }`
  - **`PLANS: Record<PlanId, Plan>`:** values from Global Constraints.
  - **`deriveMonthlyEvents(plan: Plan | "custom", spendCapUsd: number | null): number | null`**
  - **`planForLookupKey(key: string): PlanId | null`**
  - **`periodBounds(profile: { plan: string; period_start?: string; period_end?: string }, now = Date.now()): { start: string; end: string }`:** ISO dates. Free uses the UTC calendar month. Paid and custom use the stored `period_start`/`period_end`, and fall back to the calendar month if those are missing.
  - **`estimatedOverageUsd(plan: Plan, used: number): number`:** never negative.
  - **`OrgProfile.plan`** becomes `"free" | "team" | "pro" | "custom"`, and the profile gains optional `retention_days?: number`, `period_start?: string` and `period_end?: string`.
  - **Other `accounts.ts` changes:**
    - `FREE_LIMITS` stays as an alias of `PLANS.free.limits`, so existing imports keep compiling.
    - `legacyLimits(epm)` returns `{ ...FREE_LIMITS, events_per_minute: epm, monthly_events: null, analytics_queries_per_day: 10_000 }`.
    - **Avoid an import cycle:** `plans.ts` imports the `Limits` type, and `accounts.ts` re-exports `FREE_LIMITS` from `plans.ts`. If that cycles at runtime, move `Limits` into `plans.ts` and re-export it from `accounts.ts`.

- [ ] **Step 1: Write the failing tests** in `test/plans.spec.ts`:

```ts
it("matches the published plan values", () => {
	expect(PLANS.free).toMatchObject({ price_usd: 0, included_events: 50_000, overage_per_100k_usd: null, retention_days: 7, stripe: null });
	expect(PLANS.free.limits).toMatchObject({ events_per_minute: 600, monthly_events: 50_000, eval_samples_per_night: 20, max_members: 2, max_keys: 3, max_pending_invites: 2, analytics_queries_per_day: 200 });
	expect(PLANS.team).toMatchObject({ price_usd: 29, included_events: 500_000, overage_per_100k_usd: 5, retention_days: 30, stripe: { base: "team_monthly", metered: "team_metered" } });
	expect(PLANS.pro).toMatchObject({ price_usd: 199, included_events: 5_000_000, overage_per_100k_usd: 3, retention_days: 90 });
	expect(PLANS.pro.limits).toMatchObject({ events_per_minute: 30_000, eval_samples_per_night: 500, max_members: 50, max_keys: 100, analytics_queries_per_day: 10_000, monthly_events: null });
});
it.each([
	["free", null, 50_000], ["team", null, null], ["team", 20, 900_000], ["team", 0, 500_000], ["pro", 30, 6_000_000], ["custom", 50, null],
])("deriveMonthlyEvents(%s, %s) = %s", (plan, cap, want) => {
	expect(deriveMonthlyEvents(plan === "custom" ? "custom" : PLANS[plan as PlanId], cap as number | null)).toBe(want);
});
it("never estimates negative overage", () => {
	expect(estimatedOverageUsd(PLANS.team, 100_000)).toBe(0);
	expect(estimatedOverageUsd(PLANS.team, 650_000)).toBeCloseTo(7.5);
	expect(estimatedOverageUsd(PLANS.free, 80_000)).toBe(0);
});
it("maps lookup keys to plans", () => {
	expect(planForLookupKey("pro_monthly")).toBe("pro");
	expect(planForLookupKey("team_metered")).toBe("team");
	expect(planForLookupKey("nope")).toBeNull();
});
it("uses the UTC calendar month for free and the stored period for paid", () => {
	const now = Date.parse("2026-10-23T12:00:00Z");
	expect(periodBounds({ plan: "free" }, now)).toEqual({ start: "2026-10-01", end: "2026-11-01" });
	expect(periodBounds({ plan: "team", period_start: "2026-10-15", period_end: "2026-11-15" }, now)).toEqual({ start: "2026-10-15", end: "2026-11-15" });
});
it("keeps migrated tenants unlimited per month", () => expect(legacyLimits(6000)).toMatchObject({ events_per_minute: 6000, monthly_events: null }));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/plans.spec.ts`
Expected: FAIL, because `../services/billing/plans` can't be resolved.

- [ ] **Step 3: Implement the plan table and propagate the `Limits` change**
  - **`store.createOrg`:** the default limits become `PLANS.free.limits`, with `retention_days: 7`.
  - **`scripts/lib/limits.ts`:** validates `monthly_events`. `null` is allowed, written as the literal `null`.
  - **`evals/handlers.ts`:** legacy rows still go through `legacyLimits` (eval samples are unchanged).
  - **`console/routes/usage.ts` and its test:** keep compiling with a temporary `events_today: 0`. Task 2 replaces it.
  - **Run `pnpm typecheck`** and fix every reference to `events_per_day`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/plans.spec.ts && pnpm typecheck && pnpm test`
Expected: PASS everywhere. Update any existing assertion that checked `events_per_day`.

- [ ] **Step 5: Commit**

```bash
git add -A services scripts test
git commit -m "Add the plan table and replace the daily event cap with a per-period limit"
```

---

### Task 2: Per-period counter, 429s and per-plan retention at ingest

**Files:**
- Modify: `services/shared/tenants.ts`, `services/shared/schema.ts`, `services/ingest/handler.ts`, `services/console/routes/usage.ts`
- Test: `test/tenants.spec.ts`, `test/ingest.spec.ts`, `test/console.spec.ts` (usage)

**Interfaces:**
- Consumes: Task 1's `periodBounds`, `Limits.monthly_events`, profile period fields.
- Produces:
  - **`Tenant` gains:** `plan: string`, `retention_days: number` (7, 30, 90, or 30 for custom/legacy), `period_start: string` and `period_end: string`, all from `periodBounds`.
  - **`counterIds.period(org: string, periodStart: string)`:** returns `"<org>#month#<periodStart>"`. `counterIds.day` is removed.
  - **`type QuotaResult = "ok" | "minute" | "month" | "spend_cap"`**
  - **`consumeQuota(tenant, events, now)`:**
    1. Run the minute check as today.
    2. Then run the period counter with max `monthly_events ?? Number.MAX_SAFE_INTEGER` and TTL `period_end + 40 days` in epoch seconds.
    3. A refusal returns `"month"` for free and `"spend_cap"` for paid.
  - **`releaseQuota(tenant, events)`:** `ADD used -n` on the period counter. Never throws: log and swallow.
  - **`secondsUntil(isoDate: string, now = Date.now()): number`**
  - **`QueuedEvent` gains `retention_days: number`.**
  - **Usage route:** `used.events_this_period`, plus `period: { start, end }` (replacing `events_today`).

- [ ] **Step 1: Write the failing tests**

```ts
// tenants.spec.ts
it("counts events per billing period and names the refusal by plan", async () => {
	const free = { ...tenant, plan: "free", limits: { ...PLANS.free.limits, monthly_events: 10 }, period_start: "2026-10-01", period_end: "2026-11-01" };
	ddb.send.mockResolvedValueOnce({}).mockRejectedValueOnce(ccf());
	expect(await consumeQuota(free, 5)).toBe("month");
	expect(sentUpdates()[1]!.input.Key).toEqual({ window: "o1#month#2026-10-01" });
	const team = { ...free, plan: "team", limits: { ...PLANS.team.limits, monthly_events: 900_000 } };
	ddb.send.mockResolvedValueOnce({}).mockRejectedValueOnce(ccf());
	expect(await consumeQuota(team, 5)).toBe("spend_cap");
});
it("always counts paid usage even without a cap, so the meter can read it", async () => { /* monthly_events null → period Update still sent with a very large :max */ });
it("starts a new counter when the period rolls over", async () => { /* same tenant with period_start "2026-11-15" → Key window "o1#month#2026-11-15" */ });
it("releases counted events after a failed enqueue", async () => { /* releaseQuota → Update ADD used :neg with -5 on the period key; a rejection is swallowed */ });
it("stamps retention from the plan", async () => { /* tenantForKey on a pro profile → retention_days 90; legacy row → 30 */ });
```

```ts
// ingest.spec.ts
it.each([["month", "free"], ["spend_cap", "team"]])("returns 429 %s with retry-after to the period end", async (limit) => {
	tenants.consumeQuota.mockResolvedValue(limit);
	const res = await handler(request({ events: [event()] }));
	expect(res.statusCode).toBe(429);
	expect(res.headers).toMatchObject({ "x-tracewise-limit": limit, "retry-after": expect.stringMatching(/^\d+$/) });
});
it("gives the counted events back when SQS refuses them", async () => { /* send → Failed on both tries → 503 and releaseQuota called with (tenant, 1) */ });
it("puts the tenant's retention on each queued event", async () => { /* MessageBody has retention_days: 90 for a pro tenant */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/tenants.spec.ts test/ingest.spec.ts`
Expected: FAIL, because `counterIds.period` and `releaseQuota` don't exist yet.

- [ ] **Step 3: Implement**
  - `tenantForKey` builds the new `Tenant` fields from the profile through `periodBounds`.
  - The ingest handler maps the new results to 429 bodies: `"monthly event allowance used"` for `month` and `"spend cap reached"` for `spend_cap`. On the 503 path it calls `releaseQuota`.
  - The usage route reads `counterIds.period(org, periodBounds(profile).start)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/tenants.spec.ts test/ingest.spec.ts test/console.spec.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A services test
git commit -m "Meter events per billing period at ingest and stamp each event with its plan's retention"
```

---

### Task 3: Processor TTL, hot window and the deleter window follow plan retention

**Files:**
- Modify: `services/shared/keys.ts`, `services/processor/handler.ts`, `services/deleter/handler.ts`
- Test: `test/processor.spec.ts`, `test/deleter.spec.ts`, `test/shared.spec.ts`

**Interfaces:**
- Consumes: `QueuedEvent.retention_days` (Task 2).
- Produces:
  - **`MAX_RETENTION_DAYS = 90`** in `keys.ts`. `HOT_RETENTION_DAYS` stays as the default for events that carry no retention.
  - **`inHotWindow(ts, now, retentionDays = HOT_RETENTION_DAYS)`**
  - **Deleter:** `TRACE_DAYS` covers 0 to `MAX_RETENTION_DAYS + 2`, plus −1.

- [ ] **Step 1: Write the failing tests**

```ts
it("sets each item's TTL from the event's retention", async () => { /* event with retention_days 7 → expires_at = ts + 7 d; no retention_days → ts + 30 d */ });
it("keeps a Pro event from 60 days ago in the hot table", async () => { /* retention_days 90, ts now-60d → BatchWrite includes it; retention_days 7, ts now-10d → lake only */ });
it("visits every partition a Pro org can hold", async () => { /* deleter queried pks include `o1#<anchor-92d>#9` and `o1#<anchor+1d>#0`, not anchor-93d */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/processor.spec.ts test/deleter.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Update the comment in `inHotWindow` to tie the window to the deleter's coverage.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/processor.spec.ts test/deleter.spec.ts && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A services test
git commit -m "Keep traces for each plan's retention and widen the deleter to the longest one"
```

---

### Task 4: The judge budget's free pool

**Files:**
- Modify: `services/evals/handlers.ts`, `infra/lib/evals.ts` (`SAMPLE_SIZE` env default)
- Test: `test/evals-handlers.spec.ts`

**Interfaces:**
- `listTenants` splits the candidates:
  - **Free orgs** (plan `free`, and legacy rows count as custom) share `GLOBAL_JUDGE_CALLS_PER_NIGHT` as today.
  - **Paid and custom orgs** get `sample_budget = min(limits.eval_samples_per_night, SAMPLE_SIZE)`, outside the pool.
- `GlobalCapHit{Cap=judge}` fires only for free-pool shortfalls.
- `SAMPLE_SIZE` defaults to 500.

- [ ] **Step 1: Write the failing tests**

```ts
it("gives paid orgs their full allowance outside the free pool", async () => {
	// 150 free profiles (20 each) + 1 pro (500) → free share floor(2000/150)=13 each; pro sample_budget 500, sample_limit 500
});
it("reports the judge cap only for free-pool shortfalls", async () => { /* 50 free + 10 pro → no metric */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/evals-handlers.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/evals-handlers.spec.ts && pnpm exec vitest run infra/test/stack.spec.ts && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A services infra test
git commit -m "Give paid orgs their own nightly judge allowance outside the free pool"
```

---

### Task 5: Stripe client, secret access and `stripe-setup`

**Files:**
- Create: `services/billing/stripe.ts`, `scripts/stripe-setup.ts`
- Modify: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (only if needed)
- Test: `test/billing-stripe.spec.ts`, `test/stripe-setup.spec.ts`

**Interfaces:**
- **`getStripe(): Promise<Stripe>`** and **`getWebhookSecret(): Promise<string>`:** read `process.env.STRIPE_SECRET_ARN` from Secrets Manager once per instance, cache the result, and construct `new Stripe(secret_key, { apiVersion: <the SDK's pinned default>, maxNetworkRetries: 2, timeout: 10_000 })`.
- **`ensureStripeCatalog(stripe: Stripe): Promise<{ meterId: string; prices: Record<string, string> }>`:** idempotent. It finds the meter by `event_name` and prices by `lookup_keys`, and creates anything missing:
  - the meter: sum aggregation, `customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }`, `value_settings: { event_payload_key: "value" }`
  - products "Tracewise Team" and "Tracewise Pro"
  - monthly base prices of $29 and $199 (`unit_amount` 2900 and 19900)
  - graduated metered prices on the meter, using the Global Constraints tiers
  - a Customer Portal configuration that allows plan switching between `team_monthly` and `pro_monthly`, cancel at period end, payment-method update and invoice history

  It never edits existing prices, because prices are immutable. If a lookup key exists with the wrong amount, it throws with a clear message.
- **`scripts/stripe-setup.ts`:** usage is `STRIPE_SECRET_KEY=sk_test_… pnpm exec tsx scripts/stripe-setup.ts`. It refuses `sk_live_` keys unless `--live` is passed. It prints the ids, never the key.

- [ ] **Step 1: Write the failing tests**, with a hand-written Stripe stub. Don't hit the network.

```ts
it("reads the Stripe secret once per instance", async () => { /* two getStripe() calls → one GetSecretValue */ });
it("creates the meter, products and prices when none exist, with the published tiers", async () => {
	const s = stubStripe({ meters: [], prices: [] });
	await ensureStripeCatalog(s);
	expect(s.billing.meters.create).toHaveBeenCalledWith(expect.objectContaining({ event_name: "tracewise_events", default_aggregation: { formula: "sum" } }));
	expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({ lookup_key: "team_metered", tiers_mode: "graduated", tiers: [{ up_to: 500_000, unit_amount: 0 }, { up_to: "inf", unit_amount_decimal: "0.005" }] }));
	expect(s.prices.create).toHaveBeenCalledWith(expect.objectContaining({ lookup_key: "pro_monthly", unit_amount: 19_900, recurring: expect.objectContaining({ interval: "month" }) }));
});
it("is a no-op when everything exists", async () => { /* all present → no create calls */ });
it("refuses to continue when an existing price has the wrong amount", async () => { /* team_monthly at 2500 → throws /team_monthly/ */ });
```

- [ ] **Step 2: Verify they fail.**
- [ ] **Step 3: Install and implement**

```bash
pnpm add stripe@<exact version ≥14 days old> @aws-sdk/client-secrets-manager@3.1155.0
```

Check `node_modules/stripe` typings for the exact `billing.meters`, `billing.meterEvents` and `billingPortal.configurations` shapes, and use them.

- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/billing-stripe.spec.ts test/stripe-setup.spec.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A services scripts test package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "Add the Stripe client and an idempotent catalog setup script"
```

---

### Task 6: Subscription state → plan, limits and billing records

**Files:**
- Create: `services/billing/subscriptions.ts`
- Test: `test/subscriptions.spec.ts`

**Interfaces:**
- Consumes: `PLANS`, `deriveMonthlyEvents`, `planForLookupKey` (Task 1), and `ddb`/`k` from accounts.
- Produces:
  - **`interface BillingRecord`:** `{ org_id; customer_id; subscription_id: string | null; status: string; plan: PlanId; current_period_start: string | null; current_period_end: string | null; cancel_at_period_end: boolean; spend_cap_usd: number | null; past_due_since: string | null; reported_events: number; reported_period: string | null }`
  - **`getBilling(orgId): Promise<BillingRecord | null>`**
  - **`orgForCustomer(customerId): Promise<string | null>`** and **`linkCustomer(orgId, customerId): Promise<void>`:** the latter writes the `STRIPE#<customer>/CUSTOMER` item.
  - **`effectivePlan(sub: Stripe.Subscription | null, pastDueSince: string | null, now = Date.now()): PlanId | null`:**

| Subscription | Result |
|---|---|
| null, or status `canceled`, `unpaid` or `incomplete_expired` | free |
| `active` or `trialing` | the plan of the item whose price `lookup_key` is a base key |
| `past_due`, `pastDueSince` within 7 days | the paid plan |
| `past_due`, older than 7 days | free |
| `incomplete` | no change (returns `null`, and the caller skips) |

  - **`applySubscription(orgId: string, sub: Stripe.Subscription | null, now = Date.now()): Promise<{ plan: PlanId; periodChanged: boolean; previous: BillingRecord | null }>`:** does the following.
    1. Reads the BILLING item and the profile.
    2. Computes the plan.
    3. Writes PROFILE `plan`, `limits` (the plan's limits with `monthly_events` from `deriveMonthlyEvents(plan, billing.spend_cap_usd)`), `retention_days`, `period_start` and `period_end` (Stripe's `current_period_start`/`_end` as ISO dates; cleared for free).
    4. Writes the BILLING item, keeping `spend_cap_usd`, `reported_events` and `reported_period`. Sets `past_due_since` on the first `past_due` and clears it otherwise.
    5. Never touches profiles whose plan is `custom` or whose status isn't `active`.
  - **`recordEventOnce(eventId: string, type: string): Promise<boolean>`** and **`forgetEvent(eventId): Promise<void>`:** the `STRIPE_EVENT#<id>` item with a 30-day TTL.

  Read the current-period fields from wherever the pinned `stripe` version's typings put them. Newer API versions moved `current_period_*` onto subscription items, so use an accessor that handles either.

- [ ] **Step 1: Write the failing tests** (mock `../services/shared/ddb`):

```ts
it.each([
	["active", "team_monthly", null, "team"], ["trialing", "pro_monthly", null, "pro"], ["canceled", "team_monthly", null, "free"],
	["unpaid", "pro_monthly", null, "free"], ["past_due", "team_monthly", "2026-10-20T00:00:00Z", "team"], ["past_due", "team_monthly", "2026-10-10T00:00:00Z", "free"],
])("status %s on %s (past due since %s) → %s", (status, key, since, want) => {
	expect(effectivePlan(sub(status, key), since, Date.parse("2026-10-23T00:00:00Z"))).toBe(want);
});
it("leaves an incomplete subscription alone", () => expect(effectivePlan(sub("incomplete", "team_monthly"), null)).toBeNull());
it("writes plan limits, retention and period to the profile, keeping the spend cap", async () => {
	// existing BILLING spend_cap_usd 20, team active → PROFILE limits.monthly_events 900_000, retention_days 30, period_start/end from the sub
});
it("downgrades to free without touching keys, members or stored data", async () => { /* canceled → PROFILE plan free, limits = PLANS.free.limits; no Delete commands sent */ });
it("never changes a custom or deleting org", async () => { /* profile plan custom → no writes; status deleting → no writes */ });
it("reports when the billing period moved", async () => { /* previous current_period_start differs → periodChanged true */ });
it("records each Stripe event once", async () => { /* first call true; ConditionalCheckFailed → false */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/subscriptions.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write PROFILE and BILLING in one `TransactWriteCommand`, with the PROFILE update conditioned on `#s = :active AND #p <> :custom`. A condition failure means the org is skipped, not an error.
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/subscriptions.spec.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add services/billing/subscriptions.ts test/subscriptions.spec.ts
git commit -m "Map Stripe subscription state to plan limits, retention and billing records"
```

---

### Task 7: Usage metering

**Files:**
- Create: `services/billing/meter.ts`, `services/billing/meter-handler.ts`
- Test: `test/meter.spec.ts`

**Interfaces:**
- Consumes: `getStripe` (Task 5), `getBilling` and `BillingRecord` (Task 6), `counterIds.period` and `readCounter` (Task 2).
- Produces:
  - **`reportOrgUsage(billing: BillingRecord, opts: { periodStart: string; timestamp: number }): Promise<{ sent: number }>`:**
    1. Reads the counter for `periodStart`.
    2. Computes `base = billing.reported_period === periodStart ? billing.reported_events : 0` and `delta = counter − base`.
    3. If `delta > 0`, calls `stripe.billing.meterEvents.create({ event_name: "tracewise_events", payload: { stripe_customer_id, value: String(delta) }, identifier: \`${org}:${periodStart}:${counter}\`, timestamp })`.
    4. Updates BILLING with `reported_events = :counter, reported_period = :p`, conditioned on `(reported_period = :p AND reported_events = :old) OR attribute_not_exists(reported_period) OR reported_period <> :p`.
    5. A condition failure returns `{ sent: 0 }`, because another run won.
  - **`handler()` in `meter-handler.ts`:**
    1. Scans BILLING items (`sk = BILLING`) with status `active`, `trialing` or `past_due`.
    2. For each, runs `reportOrgUsage` with `periodStart = billing.current_period_start` and `timestamp = now`. Orgs run in sequence with bounded concurrency of 5, and a failure for one org doesn't stop the others.
    3. Publishes `Tracewise/Billing` metrics: `MeterOrgsReported` and `MeterFailures`, plus `MeterLastSuccessAgeMinutes = 0` when no org failed.
    4. Throws if every org failed, so Lambda Errors alarms.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends only the new events since the last report, with a retry-safe identifier", async () => {
	// counter 750_000, billing reported_period "2026-10-15", reported_events 500_000 → meterEvents.create value "250000", identifier "o1:2026-10-15:750000"; Update sets reported_events 750000
});
it("starts from zero when the period changed", async () => { /* reported_period "2026-09-15" → delta = full counter */ });
it("sends nothing when there's nothing new", async () => { /* counter == reported_events → no create */ });
it("flushes the previous period with a timestamp inside it", async () => { /* reportOrgUsage(b, { periodStart: "2026-09-15", timestamp: periodEnd-1 }) → create.timestamp === that */ });
it("keeps going when one org fails, and fails the run only if all do", async () => { /* 3 orgs, 1 rejects → no throw, MeterFailures 1; all reject → throws */ });
it("loses the race politely", async () => { /* conditional Update fails → { sent: 0 } and no throw */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/meter.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/meter.spec.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add services/billing/meter.ts services/billing/meter-handler.ts test/meter.spec.ts
git commit -m "Report each org's new events to the Stripe meter hourly"
```

---

### Task 8: Stripe webhook

**Files:**
- Create: `services/billing/webhook.ts`
- Test: `test/webhook.spec.ts`

**Interfaces:**
- Consumes: `getStripe`, `getWebhookSecret` (Task 5); `applySubscription`, `orgForCustomer`, `linkCustomer`, `recordEventOnce`, `forgetEvent`, `getBilling` (Task 6); `reportOrgUsage` (Task 7).
- Produces **`handler(event: APIGatewayProxyEventV2)`**, which does the following:
  1. Takes the raw body: `Buffer.from(body, "base64")` when `isBase64Encoded`, otherwise `body`.
  2. Verifies it with `stripe.webhooks.constructEvent(raw, headers["stripe-signature"], secret)`. Failure returns `400 { error: "bad signature" }`.
  3. Calls `recordEventOnce`. If the event was already seen, returns `200 { ok: true, duplicate: true }`.
  4. Dispatches on the event type:
     - **`checkout.session.completed`:** takes the org from `client_reference_id`, calls `linkCustomer(org, customer)`, retrieves the subscription, then runs `applySubscription`.
     - **`customer.subscription.created`, `.updated` and `.deleted`:** takes the org from `metadata.org_id` or `orgForCustomer`. It re-fetches the subscription by id (a 404 means null, i.e. deleted). If `applySubscription` reports `periodChanged`, it first runs `reportOrgUsage(previous, { periodStart: previous.current_period_start, timestamp: Date.parse(previous.current_period_end) − 1000 })`.
     - **`invoice.paid` and `invoice.payment_failed`:** re-fetch the invoice's subscription and run `applySubscription`.
     - **Other types:** return 200.
  5. **Errors:**
     - **Unknown org:** log a warning and return 200, so Stripe doesn't retry forever.
     - **Unexpected error:** calls `forgetEvent`, then returns 500 so Stripe retries.
  6. Logs only the event id, type and org id.

- [ ] **Step 1: Write the failing tests**, using `stripe.webhooks.generateTestHeaderString({ payload, secret })` for real signatures:

```ts
it("accepts a correctly signed body, raw or base64", async () => { /* both → 200; constructEvent got the exact bytes */ });
it.each(["tampered body", "wrong secret", "stale timestamp"])("rejects a %s", async () => { /* → 400, no applySubscription */ });
it("ignores a replayed event", async () => { /* recordEventOnce false → 200 duplicate, no Stripe calls */ });
it("links the customer and applies the plan after checkout", async () => { /* checkout.session.completed with client_reference_id o1 → linkCustomer(o1, cus_1), subscriptions.retrieve, applySubscription(o1, sub) */ });
it("re-fetches instead of trusting the event, so a stale update can't revive a canceled plan", async () => {
	// event says status active, retrieve returns canceled → applySubscription called with the canceled sub
});
it("flushes the old period's usage before switching periods", async () => {
	// applySubscription → { periodChanged: true, previous: { current_period_start: "2026-09-15", current_period_end: "2026-10-15T00:00:00Z", ... } } → reportOrgUsage called with periodStart "2026-09-15" and timestamp 2026-10-15T00:00:00Z - 1s, before returning 200
});
it("lets Stripe retry after an unexpected error", async () => { /* applySubscription rejects → 500 and forgetEvent(evt_1) */ });
it("treats an unknown customer as handled", async () => { /* orgForCustomer null, no metadata → 200, warn logged */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/webhook.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Note an ordering subtlety: when `periodChanged` is true, the flush must use the **previous** BILLING record's period and its `reported_*` values. `applySubscription` returns `previous` for this purpose. The flush runs after the write, which is safe because it reads the old period's counter key, which no longer changes.
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/webhook.spec.ts && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add services/billing/webhook.ts test/webhook.spec.ts
git commit -m "Apply Stripe subscription changes from a verified, idempotent webhook"
```

---

### Task 9: Console billing routes

**Files:**
- Create: `services/console/routes/billing.ts`
- Modify: `services/console/route-keys.ts`, `services/console/handler.ts`, `services/console/routes/keys.ts` and `team.ts` (only if the over-limit 409 needs changes)
- Test: `test/console.spec.ts`, `test/console-routes.spec.ts` (count 16 → 20)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6.
- Produces four routes added to `CONSOLE_ROUTES`:
  - **`GET /v1/orgs/{orgId}/billing`** (member) returns `{ plan, status, current_period_end, cancel_at_period_end, events_this_period, included_events, estimated_overage_usd, spend_cap_usd, past_due }`. For free or custom orgs, `status` is `"none"` and the Stripe fields are null.
  - **`POST /v1/orgs/{orgId}/billing/checkout`** (owner) with zod body `{ plan: z.enum(["team", "pro"]) }`:
    1. If a subscription is `active`, `trialing` or `past_due`, return `409 { error: "already subscribed, use Manage billing" }`.
    2. Reuse `billing.customer_id`. Otherwise create a customer with `metadata.org_id` and `email: claims.email`, then call `linkCustomer`.
    3. Create a session: `stripe.checkout.sessions.create({ mode: "subscription", customer, client_reference_id: org, line_items: [{ price: <base id> , quantity: 1 }, { price: <metered id> }], subscription_data: { metadata: { org_id } }, automatic_tax: { enabled: true }, customer_update: { address: "auto" }, allow_promotion_codes: true, success_url: \`${CONSOLE_ORIGIN}/console/index.html#/billing?checkout=success\`, cancel_url: …#/billing })`. Price ids are resolved by lookup key and cached per instance.
    4. Return `{ url }`.
  - **`POST /v1/orgs/{orgId}/billing/portal`** (owner): with no `customer_id`, return `409 { error: "no billing account yet" }`. Otherwise return `{ url }` for a portal session with `return_url …#/billing`.
  - **`PATCH /v1/orgs/{orgId}/billing`** (owner) with body `{ spend_cap_usd: z.number().min(0).max(100_000).nullable() }`:
    1. Free or custom returns `409 { error: "spend caps apply to paid plans" }`.
    2. Otherwise update BILLING `spend_cap_usd` and PROFILE `limits.monthly_events = deriveMonthlyEvents(plan, cap)` in one transaction.
    3. Return the GET shape.
- Existing caps (`max_keys`, `max_members`, `max_pending_invites`) already return 409 when at or over the limit, which covers downgrades. Add a test.

- [ ] **Step 1: Write the failing tests**

```ts
it("shows billing to members but lets only owners change it", async () => { /* member GET 200; member POST checkout / portal / PATCH → 403 */ });
it("creates a Checkout session with base + metered prices, tax and the org reference", async () => { /* stripe stub: checkout.sessions.create called with mode subscription, client_reference_id o1, two line items by looked-up ids, automatic_tax enabled; response { url } */ });
it("refuses checkout when already subscribed", async () => { /* billing status active → 409 */ });
it("refuses the portal before there's a customer", async () => { /* → 409 */ });
it("applies a spend cap below current usage immediately", async () => {
	// team, counter 800_000, PATCH cap 10 → monthly_events 700_000 written; GET shows estimated_overage_usd 15 (never negative), spend_cap_usd 10
});
it("rejects caps on free plans and out-of-range values", async () => { /* free → 409; -1 or 100_001 → 400 */ });
it("blocks new keys after a downgrade but keeps existing ones", async () => { /* 5 keys, free max_keys 3 → POST keys 409 limit max_keys; GET keys still lists 5 */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/console.spec.ts test/console-routes.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Stripe is mocked through `vi.mock("../services/billing/stripe")`.
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/console.spec.ts test/console-routes.spec.ts && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A services test
git commit -m "Add billing routes: status, Checkout, Customer Portal and spend caps"
```

---

### Task 10: Infrastructure

**Files:**
- Create: `infra/lib/billing.ts`
- Modify: `infra/lib/tracewise-stack.ts`, `infra/lib/accounts.ts` (billing routes reuse the console integration and authorizer), `infra/test/stack.spec.ts`

**Interfaces:**
- **`class Billing extends Construct`** with props `{ fn; accounts: ITableV2; quotas: ITableV2; alerts: ITopic; consoleFn: IFunction }`. It creates:
  - **The secret:** `Secret` (name generated by CDK; exposed as the `StripeSecretArn` output), generated with placeholder JSON. Operators replace the values.
  - **`billingWebhookFn`** (`billing/webhook.ts`, 15 s): env `ACCOUNTS_TABLE`, `QUOTAS_TABLE`, `STRIPE_SECRET_ARN`.
  - **`billingMeterFn`** (`billing/meter-handler.ts`, 5 min, the same env): an EventBridge Scheduler rate of 1 hour.
  - **Grants:**
    - `secret.grantRead` for the webhook, meter and console functions only
    - Accounts read/write and Quotas read for both billing functions
    - `cloudwatch:PutMetricData` conditioned on namespace `Tracewise/Billing` for the meter
    - `STRIPE_SECRET_ARN` on the console function
  - **Alarms** on the existing topic:
    - `BillingWebhookErrors`: webhook Errors ≥ 1 over 5 minutes
    - `BillingMeterErrors`: meter Errors ≥ 1 over 1 hour
    - `BillingMeterStale`: `MeterLastSuccessAgeMinutes` missing for 3 hours, using `treatMissingData: BREACHING` on a 3-hour, 1-period SampleCount < 1
- **Public route:** `POST /v1/stripe/webhook` goes to `billingWebhookFn` with **no authorizer**, added in the stack next to the existing routes. It's called at the API Gateway URL. The README tells operators to register `<ApiUrl>/v1/stripe/webhook` with Stripe.
- **Billing routes:** the 4 new console routes are added through the existing `CONSOLE_ROUTES` loop with the JWT authorizer, automatically, since they're in `CONSOLE_ROUTES`.
- **Outputs:** `StripeSecretArn` and `StripeWebhookUrl`.

- [ ] **Step 1: Write the failing assertions**
  - **Counts:** functions 11 → 13, alarms 7 → 10, and one new `AWS::Scheduler::Schedule` (2 schedules in total).

```ts
it("leaves the Stripe webhook public and puts billing routes behind the JWT authorizer", () => {
	expect(routeByKey("POST /v1/stripe/webhook")?.AuthorizationType ?? "NONE").toBe("NONE");
	for (const k of ["GET /v1/orgs/{orgId}/billing", "POST /v1/orgs/{orgId}/billing/checkout", "POST /v1/orgs/{orgId}/billing/portal", "PATCH /v1/orgs/{orgId}/billing"]) expect(routeByKey(k)).toMatchObject({ AuthorizationType: "JWT" });
});
it("lets only the billing and console functions read the Stripe secret", () => {
	const readers = policiesMentioning("secretsmanager:GetSecretValue").map(rolesOf);
	expect(readers.sort()).toEqual([expect.stringMatching(/BillingMeter/), expect.stringMatching(/BillingWebhook/), expect.stringMatching(/ConsoleFn/)].sort());
	for (const r of [/Ingest/, /Processor/, /Query/, /Summary/, /EvalsApi/]) expect(JSON.stringify(policiesFor(r))).not.toContain("secretsmanager");
});
it("reports usage hourly and alarms when metering stalls", () => { /* schedule rate(1 hour) targeting BillingMeter; alarms BillingMeterStale/Errors, BillingWebhookErrors exist */ });
it("covers the longest retention in the deleter", () => { /* import MAX_RETENTION_DAYS and PLANS: Math.max(...retention_days) <= MAX_RETENTION_DAYS */ });
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run infra/test/stack.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run infra/test/stack.spec.ts && pnpm synth && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add -A infra
git commit -m "Deploy billing: Stripe secret, webhook, hourly meter, routes and alarms"
```

---

### Task 11: Console Billing screen, banners, usage and pricing page

**Files:**
- Create: `dashboard/console/views/billing.js`, `dashboard/pricing.html`
- Modify: `dashboard/console/router.js` (add `billing`), `dashboard/console/app.js` (nav link + banners), `dashboard/console/views/usage.js`, `dashboard/console/console.css`, `dashboard/index.html` (Pricing link)
- Test: `test/console-views.spec.ts`, `test/pricing-page.spec.ts` (new)

**Interfaces:**
- Consumes: the API shapes from Task 9, plus `GET /v1/orgs/{id}/usage`'s new `events_this_period` and `period`.
- Produces:
  - **From `billing.js`:** `billingSummary(b): { planLabel: string; usageLine: string; overageLine: string | null; renewalLine: string }`, a pure helper for tests.
  - **From `app.js`:** a pure function `bannersFor(billing, usage): { kind: "info" | "warn" | "danger"; text: string }[]`. It gives 80% and 100% of included events, spend cap reached, and past due.
  - **`usageRows`** replaces "Events today" with "Events this period". Its limit is `monthly_events ?? included` and its note is "Paid plans keep accepting events and bill overage" for paid plans, or "Ingest returns 429 until the period ends" for free.
  - **`pricing.html`** is static, with no script. It has a `<table id="plans">`, columns `Free | Team | Pro | Enterprise`, and rows labelled exactly: `Price`, `Included events`, `Extra events`, `Judge samples per night`, `Hot retention`, `Events per minute`, `Members`.

**Billing screen:**
- **Plan card:** label, status, renewal or cancellation date, a usage bar from `magnitude()`, and estimated overage.
- **Spend cap:** an owner-only number field with a Save button (PATCH).
- **Free orgs:** plan cards for Team and Pro with Upgrade buttons (POST checkout, then `location.assign(url)`).
- **Paid orgs:** a Manage billing button (POST portal, then assign).
- **After returning from Checkout:** `?checkout=success` shows "Thanks, your plan updates within a minute" and refreshes billing every 5 s, up to 6 times.
- **Safety:** everything renders through `el()`, with no `style=`.

- [ ] **Step 1: Write the failing tests**

```ts
it("summarises a paid plan's usage and overage", () => {
	expect(billingSummary({ plan: "team", status: "active", events_this_period: 650_000, included_events: 500_000, estimated_overage_usd: 7.5, spend_cap_usd: null, current_period_end: "2026-11-15T00:00:00Z", cancel_at_period_end: false })).toMatchObject({ planLabel: "Team", overageLine: expect.stringContaining("$7.50") });
});
it("raises the right banners", () => {
	expect(bannersFor({ plan: "free", events_this_period: 41_000, included_events: 50_000 }, {}).map((b) => b.kind)).toEqual(["warn"]);
	expect(bannersFor({ plan: "team", past_due: true, events_this_period: 0, included_events: 500_000 }, {}).map((b) => b.kind)).toEqual(["danger"]);
});
it("publishes the same prices and allowances the code enforces", () => {
	const table = parsePlansTable(readFileSync("dashboard/pricing.html", "utf8"));   // tiny regex/DOM-free parser in the test
	expect(table.Price).toEqual(["$0", "$29/mo", "$199/mo", "Contact us"]);
	expect(table["Included events"]).toEqual(["50,000", "500,000", "5,000,000", "Custom"]);
	expect(table["Extra events"]).toEqual(["—", "$5 per 100k", "$3 per 100k", "Custom"]);
	expect(table["Hot retention"]).toEqual([`${PLANS.free.retention_days} days`, `${PLANS.team.retention_days} days`, `${PLANS.pro.retention_days} days`, "Custom"]);
});
```

- [ ] **Step 2: Verify they fail.** Run: `pnpm exec vitest run test/console-views.spec.ts test/pricing-page.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify**
  - Run: `pnpm exec vitest run test/console-views.spec.ts test/pricing-page.spec.ts && pnpm test`. Expected: PASS.
  - Browser check: with the local static server and a stubbed `fetch`, the same method as the self-serve console verification, walk `#/billing` for a free org and a paid org. Check mobile width and dark mode, then take a screenshot.
- [ ] **Step 5: Commit**

```bash
git add -A dashboard test
git commit -m "Add the Billing screen, usage banners and a public pricing page"
```

---

### Task 12: Operator scripts, live-test script and docs

**Files:**
- Create: `scripts/apply-plan-limits.ts`, `scripts/smoke-billing.ts`
- Modify: `README.md`, `docs/design.md`, the spec (a short "Changes during planning" section, if anything changed)
- Test: `test/apply-plan-limits.spec.ts`

**Interfaces:**
- **`scripts/lib/plan-limits.ts`:** `planFreeUpgrade(profile: OrgProfile): Partial<OrgProfile> | null`. It returns the PROFILE changes for a `free` org: limits become `PLANS.free.limits` and `retention_days` becomes 7. It returns null for orgs that already match, and for `custom`, paid or non-active orgs.
- **`scripts/apply-plan-limits.ts`:** scans PROFILEs, applies each change with a conditional update (`plan = :free AND #s = :active`), and prints counts.
- **`scripts/smoke-billing.ts`:** requires `STRIPE_SECRET_KEY=sk_test_…` and refuses live keys. It also reads the stack outputs. It does the following:
  1. Creates a Cognito test user and an org through the console API (reusing the helpers from `smoke-selfserve.ts`).
  2. Creates a Stripe test clock, then a customer on that clock with `pm_card_visa` and `metadata.org_id`, then `linkCustomer` (written directly through the store), then a subscription with `team_monthly` and `team_metered`.
  3. Polls `GET …/billing` until the plan is `team`, for up to 60 s. This proves the webhook works.
  4. Ingests a small batch with the org's key.
  5. Runs the meter, either by invoking the meter Lambda or by calling `reportOrgUsage` directly with operator credentials.
  6. Checks a Stripe meter event summary for the customer equals the ingested count.
  7. Advances the test clock past `current_period_end` and waits for `ready`.
  8. Checks the finalized invoice has the base line ($29) and a metered line equal to the reported quantity at the tier price (0 for a small batch). An optional `--overage` flag ingests 500,001 events and expects a $0.00005 line.
  9. Cancels, then checks the org is back on `free` within 60 s.
  10. Cleans up in `finally`: deletes the test clock, which removes its customer, then the org and the Cognito user.
- **README:**
  - pricing and the plan table, linked to `/pricing.html`
  - Stripe setup, in order:
    1. `stripe-setup` in test mode
    2. put the keys in the secret at the `StripeSecretArn` output
    3. register the webhook URL from the `StripeWebhookUrl` output with the events from spec §8
    4. `smoke-billing`
    5. the go-live checklist from spec §14
  - `apply-plan-limits` in the rollout steps
- **`docs/design.md`:** billing moves out of the non-goals, with a short paragraph on how billing works.

- [ ] **Step 1: Write the failing tests** for `planFreeUpgrade`: a free org on old limits gets an update, an already-current free org gets null, and custom, team or deleting orgs get null.
- [ ] **Step 2: Verify they fail.**
- [ ] **Step 3: Implement the scripts and docs.** Check that `smoke-billing.ts` prints usage and exits 1 before any network call when inputs are missing or the key is live.
- [ ] **Step 4: Verify.** Run: `pnpm exec vitest run test/apply-plan-limits.spec.ts && pnpm typecheck && pnpm test`. Expected: PASS. Also run `node --import tsx scripts/smoke-billing.ts --help`, which should exit 0 with no network call.
- [ ] **Step 5: Commit**

```bash
git add -A scripts test README.md docs
git commit -m "Add plan-limit migration, a Stripe test-mode smoke test and billing docs"
```
