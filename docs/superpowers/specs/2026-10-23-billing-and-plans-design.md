# Billing and plans: design

**Status:** Approved design, pending spec review · **Date:** 2026-10-23 · **Builds on:** [self-serve accounts](2026-10-22-self-serve-accounts-design.md) (branch `self-serve-accounts`, PR #1)

## 1. Intent

Tracewise has self-serve sign-up, orgs, keys and free-tier limits. This spec makes it sellable: paid plans with card checkout, usage-based overage, and per-plan limits that follow the subscription automatically.

**What was decided**
- The first paying customer is a small team or startup (1–20 engineers) buying by card. There are no sales calls.
- Paid plans keep accepting events past their included amount and bill the overage at month end. Customers can set a spend cap.
- Judge samples are included per plan. They are not metered.
- Stripe-hosted Checkout, Customer Portal, Billing Meters and Stripe Tax.

**What success looks like**
- An owner upgrades from the console, pays in Stripe Checkout, and their org's limits change within a minute.
- An org's invoice shows its base price plus the correct overage for the events it sent. A Stripe outage never drops traces.
- Gross margin stays at or above 70% at included usage (80% once judge calls move to Bedrock batch inference) and 90% on overage.

**Non-goals for this spec:** annual plans (Stripe needs every price in a subscription to share one interval, so annual plans can't carry the monthly overage meter; revisit with a yearly meter or prepaid credits), per-seat pricing, enterprise contracts and invoicing, usage emails (they need SES, covered by a separate launch-hardening task), a merchant of record, multiple currencies, and refunds beyond the Stripe dashboard.

## 2. Unit economics

Region us-east-1, the stack's batch-100 defaults, events of about 3 KB. DynamoDB and Bedrock prices are from the AWS Pricing API (2026-10-23); the others are AWS public prices. Check them with the Pricing Calculator before publishing.

| Line item | Per 1M events |
|---|---|
| DynamoDB writes ($0.625 per million WRU, 3 WRU per event) | ~$1.90 |
| Firehose (5 KB record minimum, Parquet conversion, dynamic partitioning) | ~$0.35 |
| SQS (send, receive and delete, batched) | ~$0.12 |
| API Gateway, ingest and processor Lambdas, logs, X-Ray | ~$0.20 |
| **Ingest and storage, one-off** | **≈ $2.60** |
| DynamoDB storage over the hot window | ~$0.25 per GB-month (≈ $0.75/month per 1M events/month at 30 days) |
| S3 Parquet for one year | ~$0.01/month per 1M |
| Athena analytics query | ~$0.0001 each |

The load test is consistent with this: about 750k events cost about $2–3 (experiments.md). Plan on roughly **$3 per million events**, with DynamoDB writes about 70% of it.

**Judge sample:** about 1,500 input and 100 output tokens on Nova Pro ($0.0008 and $0.0032 per 1K on demand; batch inference is half that), plus Step Functions and Lambda. That's about **$0.0017 per sample on demand and $0.0009 with batch inference**.

**Fixed costs:** about $10–20 a month for WAF, alarms, SES, Route 53 and Secrets Manager. Cognito is free up to 10k monthly active users.

**Stripe fees:** 2.9% + $0.30 per charge, Stripe Billing at about 0.7% of billing volume, and Stripe Tax at about 0.5%.

## 3. Plans

| | Free | Team | Pro | Enterprise |
|---|---|---|---|---|
| Price | $0 | $29/month | $199/month | Contact us |
| Included events per period | 50,000 (hard cap) | 500,000 | 5,000,000 | Custom |
| Extra events | refused (429) | $5 per 100,000 | $3 per 100,000 | Custom |
| Judge samples per night | 20 (from the shared free pool) | 100 | 500 | Custom |
| Hot retention | 7 days | 30 days | 90 days | Custom |
| Lake retention | 1 year | 1 year | 1 year | Custom |
| Events per minute | 600 | 6,000 | 30,000 | Custom |
| Members / keys / pending invites | 2 / 3 / 2 | 10 / 20 / 10 | 50 / 100 / 50 | Custom |
| Analytics queries per day | 200 | 2,000 | 10,000 | Custom |

- Billing is per org, not per seat.
- Enterprise is set by an operator with `scripts/set-limits.ts` (plan `custom`).
- Orgs migrated from before self-serve keep plan `custom`, so the public demo and load-test tenants are unaffected.

**Gross margin at included usage**, with judge samples on on-demand Bedrock (v1):

| Plan | Our cost | Stripe fees | Margin |
|---|---|---|---|
| Free | ~$1.20 a month | none | acquisition cost |
| Team | ~$6.70 | ~$1.40 | ~72% on $29 (~80% with batch inference) |
| Pro | ~$43 | ~$8 | ~74% on $199 (~80% with batch inference) |
| Overage | ~$0.30 per 100k | ~4% | ≥ 90% |

## 4. Plan table in code

`services/billing/plans.ts` exports `PLANS: Record<"free" | "team" | "pro", Plan>`:

```
Plan {
  limits: Limits
  retention_days: number
  included_events: number
  overage_per_100k_usd: number | null
  stripe: { base: string; metered: string } | null   // Stripe price lookup keys
}
```

`PLANS` replaces `FREE_LIMITS` as the source of truth for each plan's allowances. `Limits` (`services/shared/accounts.ts`) changes in three ways:
- It gains `monthly_events` (`number | null`, where null means unlimited).
- It drops `events_per_day`. Migrated `custom` orgs keep their existing `legacyLimits`, with `monthly_events = null`.
- `eval_samples_per_night` keeps its name.

`PROFILE` gains `retention_days` and `period_start` (ISO date).

## 5. Stripe setup

`scripts/stripe-setup.ts` is idempotent: it finds or creates every object by `lookup_key` or meter `event_name`, and runs against whichever key it's given. It sets up:
- **Meter** `tracewise_events`, which sums the values sent to it, keyed by customer through the `stripe_customer_id` payload key.
- **Products** Team and Pro. Each has:
  - a monthly base price (`team_monthly`, `pro_monthly`)
  - a metered price on the meter, graduated by event count:

| Metered price | Events | Price per event |
|---|---|---|
| `team_metered` | first 500,000 | $0 |
| `team_metered` | each one after | $0.00005 (`unit_amount_decimal: "0.005"` cents) |
| `pro_metered` | first 5,000,000 | $0 |
| `pro_metered` | each one after | $0.00003 |

  A subscription is the monthly base price plus the monthly metered price.
- **Customer Portal configuration:** ~~plan switching between Team and Pro,~~ cancellation at period end, payment method updates and invoice history. *(Superseded: plan switching moved to a console route — see Changes.)*
- **Stripe Tax** enabled. Checkout uses `automatic_tax`. *(`stripe-setup` now checks it is active — see Changes.)*

Secrets go in Secrets Manager:
- A Secrets Manager secret, named by CDK and found through the `StripeSecretArn` stack output, holds `{ secret_key, webhook_secret }`.
- Billing functions read it once per cold start. *(Superseded: re-read every 5 minutes — see Changes.)*
- Only those functions get `secretsmanager:GetSecretValue` on it.

New runtime dependency: the official `stripe` npm package, pinned to an exact version.

## 6. Data model (Accounts table)

| pk | sk | Attributes |
|---|---|---|
| `ORG#<id>` | `PROFILE` | existing fields, plus `retention_days` and `period_start` |
| `ORG#<id>` | `BILLING` | `customer_id`, `subscription_id`, `status`, `plan`, `current_period_start`, `current_period_end`, `cancel_at_period_end`, `spend_cap_usd` (null = none), `past_due_since`, `reported_events`, `reported_period` |
| `STRIPE#<customer_id>` | `CUSTOMER` | `org_id` |
| `STRIPE_EVENT#<event_id>` | `EVENT` | `type`, `received_at`, `expires_at` (30 days) |

`org_id` is also set as `metadata.org_id` on the Stripe customer and subscription, and as `client_reference_id` on Checkout Sessions.

## 7. Console API (on the console Lambda, JWT)

| Route | Role | Behaviour |
|---|---|---|
| `GET /v1/orgs/{id}/billing` | member | `{ plan, status, current_period_end, cancel_at_period_end, events_this_period, included_events, estimated_overage_usd, spend_cap_usd, past_due }` |
| `POST /v1/orgs/{id}/billing/checkout` `{ plan: "team" \| "pro" }` | owner | Reuses or creates the Stripe customer (and writes `STRIPE#…/CUSTOMER`). Creates a subscription-mode Checkout Session with the base and metered prices, `automatic_tax`, `allow_promotion_codes`, `client_reference_id`, and success/cancel URLs back to `#/billing`. Returns `{ url }`. Returns 409 if a subscription is already active (use the portal). |
| `POST /v1/orgs/{id}/billing/portal` | owner | Returns `{ url }` for a Customer Portal session. 409 if there is no customer yet. |
| `PATCH /v1/orgs/{id}/billing` `{ spend_cap_usd: number \| null }` | owner | Range 0–100,000, or null. Recomputes `limits.monthly_events`. Paid plans only. |

## 8. Webhook

- **Route:** `POST /v1/stripe/webhook`. No authorizer. Served by a new `billing-webhook` Lambda, called directly at the API Gateway URL (not through CloudFront).
- **Verification:**
  1. Verify `Stripe-Signature` against the raw body with the webhook secret and Stripe's default timestamp tolerance. Use the base64-decoded body when `isBase64Encoded` is set. A bad signature returns 400.
  2. Write `STRIPE_EVENT#id` with `attribute_not_exists`. If it already exists, return 200 and do nothing.
- **Events handled:** `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Other events return 200.
- **Handling:** for each event, resolve the org through metadata, then `STRIPE#customer`. Re-fetch the subscription from Stripe, so events arriving out of order or late can't apply stale state. Then apply `applySubscription(org, subscription)`:

| Subscription state | Plan applied | Notes |
|---|---|---|
| `active`, `trialing` | the plan for the subscription's base price lookup key | |
| `past_due` | keep the paid plan | sets `past_due_since` if unset; after 7 days, treated as canceled |
| `unpaid`, `canceled`, `incomplete_expired`, deleted | free | |
| `incomplete` | no change | |

- **What `applySubscription` writes:**
  - PROFILE: `plan`, `limits` (with `monthly_events` from §9), `retention_days`, `period_start`
  - the BILLING item
- **Period rollover:** when `current_period_start` changes, it first runs the meter flush for the old period (§10).
- **Downgrades never delete data.** Stored events keep their TTL. Keys and members above the new limits stay, but no more can be added.
- **Errors:** an unexpected failure returns 500, so Stripe retries. The event record is written first, but if processing fails it is deleted, so the retry gets processed.

## 9. Limits enforcement

`limits.monthly_events` is derived as follows (in `services/billing/plans.ts` → `deriveMonthlyEvents(plan, spendCapUsd)`):

| Case | `monthly_events` |
|---|---|
| free | 50,000 |
| paid, no spend cap | null |
| paid, spend cap | included + floor(spend_cap_usd ÷ overage_per_100k_usd × 100,000) |
| custom | null |

**Ingest** (`services/shared/tenants.ts`, `consumeQuota`):
- **Counters:** the per-minute check (`limits.events_per_minute`) is unchanged. The per-day counter is replaced by a per-period counter `"<org>#month#<period_start>"`, checked against `monthly_events` when that isn't null and always incremented (the meter reads it). TTL is the period end plus 40 days.
- **Rollback on failure:** if the SQS enqueue fails after counting, the period counter is decremented by the same amount.
- **429 responses:** `x-tracewise-limit` is `month` (free) or `spend_cap` (paid), with `retry-after` set to the seconds until the period ends. For free, the period ends at the next UTC month; for paid, at `current_period_end`, carried as `period_end` on PROFILE.

**Per-plan retention:**
- Ingest stamps `retention_days` on each queued event.
- The processor uses it for the TTL and for the hot-write window, replacing `HOT_RETENTION_DAYS` in both. Events with no value use 30.
- The deleter's trace window becomes `MAX_RETENTION_DAYS + 2` (92) days back.

**Judge budget:**
- `GLOBAL_JUDGE_CALLS_PER_NIGHT` (2,000) becomes the **free pool**, shared among free orgs as today.
- Paid and custom orgs get `min(limits.eval_samples_per_night, SAMPLE_SIZE cap)` outside the pool.
- `SAMPLE_SIZE` rises to the largest paid allowance (500).
- Judge calls stay on on-demand Bedrock in v1. Moving them to batch inference (half price) belongs with the eval-scaling follow-up.

## 10. Usage metering

- **Schedule:** EventBridge Scheduler runs a new `billing-meter` Lambda every hour.
- **Each run:**
  1. For every BILLING item with `status` in `active | trialing | past_due`, read the period counter.
  2. Compute `delta = counter − reported_events` (`reported_events` resets when `reported_period` differs).
  3. If `delta > 0`, send `stripe.billing.meterEvents.create({ event_name: "tracewise_events", payload: { stripe_customer_id, value: delta }, identifier: "<org>:<period_start>:<counter>", timestamp })`.
  4. Update BILLING `reported_events` with the condition `reported_events = :old`.
- **Retries:** a failed send is retried on the next run with a larger delta. The `identifier` makes a double send harmless.
- **Flush at rollover:** the webhook calls the same function for the old period with `timestamp = current_period_end − 1`. That happens before Stripe finalizes the draft invoice, about an hour after the period ends.
- **Alarms:** errors on the meter Lambda, and a custom metric `MeterLastSuccessAgeMinutes` above 180.

## 11. Console

- **Billing screen** (`#/billing`, members see it, owners can act):
  - plan and status, renewal or cancellation date
  - a usage bar showing included and overage, and the estimated next bill
  - a spend-cap field
  - plan cards (Team and Pro) that open Checkout, and a Manage billing button that opens the Portal
- **Shell banners:** 80% and 100% of included events, spend cap reached, past due.
- **Usage screen:** shows events this period against included events instead of events today.
- **Public `dashboard/pricing.html`**, linked from the demo header and the console. A unit test parses its plan table and checks it against `PLANS`.

## 12. Infrastructure and IAM

New resources:
- the `billing-webhook` and `billing-meter` Lambdas
- the Stripe secret (CDK-named; the `StripeSecretArn` output)
- the hourly schedule
- the meter alarms
- the public webhook route

| Function | Access |
|---|---|
| billing-webhook | Accounts read/write, Quotas read (flush), the Stripe secret, invoking the meter flush (shared module, not a Lambda call) |
| billing-meter | Accounts read/write, Quotas read, the Stripe secret, PutMetricData on namespace `Tracewise/Billing` |
| console | additionally the Stripe secret (Checkout and Portal sessions) |
| ingest, processor | unchanged grants. New fields only. |

CDK assertions:
- the webhook route has no authorizer, and the billing routes use JWT
- only the three functions above can read the secret
- the schedule and alarms exist
- the deleter's window constant is at least the longest retention

## 13. Testing

**Unit tests:**
- `deriveMonthlyEvents` for each plan, with and without a spend cap
- the `applySubscription` state mapping (every status, the past-due grace period, out-of-order re-fetch)
- webhook signatures: valid, tampered body, stale timestamp, base64 body
- webhook idempotency: replays, and processing errors that release the event record
- the ingest period counter: increment, the 429 headers for `month` and `spend_cap`, and the decrement when an enqueue fails
- processor TTL taken from `retention_days`
- the meter: delta, the `identifier` value, the conditional update, rollover flush, skipping when there is nothing to send
- the checkout and portal routes: owner only, 409 cases
- the pricing page matching `PLANS`

**Live test in Stripe test mode:** `scripts/smoke-billing.ts`
1. Create a test org with a Stripe test clock, a customer with `pm_card_visa`, and a Team subscription created through the API.
2. Check that the webhook moved the org to Team limits.
3. Ingest 600k events ~~(scaled down: `--included` can override the plan for this test only)~~, then run the meter. *(Superseded: there is no `--included`; `--overage` ingests 500,001 real events — see Changes.)*
4. Advance the test clock past the period.
5. Check that the finalized invoice has base plus overage for 100k events at $5.
6. Cancel, check the org returns to Free limits, then clean up.

Checkout and the Portal are clicked through once by hand. *(The Portal no longer switches plans — see Changes.)*

## 14. Rollout

1. Build and deploy with Stripe test keys. Run `stripe-setup` in test mode, register the webhook endpoint, then run `smoke-billing` and a manual Checkout and Portal pass.
2. `scripts/apply-plan-limits.ts` (idempotent) moves existing `free` orgs to the new Free limits: a monthly cap in place of the daily cap, and 7-day retention for new events. `custom` orgs are untouched.
3. Before live mode (the owner's side):
   - activate the Stripe account
   - register for tax where Stripe Tax shows thresholds
   - publish terms of service, privacy and refund policy pages and link them from Checkout and the console
   - preferably, move to a real domain
4. Put live keys in the secret, run `stripe-setup` in live mode, and create the live webhook endpoint at the same URL.

## 15. Open items for later specs

- Usage emails at 80% and 100% (needs SES).
- Moving the judge to Bedrock batch inference (with the eval-scaling work).
- Annual plans (a yearly meter or prepaid event credits).
- Enterprise: invoicing, contracts, SSO.
- Tracking where an org's DynamoDB writes go when its items are smaller than 3 KB, to tighten cost estimates.

## Changes during planning and implementation

What changed from the sections above, one line each.

- **`PROFILE` also carries `period_end`**, which ingest needs for `retry-after`; §6's table lists only `period_start`.
- **The stale-meter alarm** works from a `MeterLastSuccessAgeMinutes = 0` datapoint the meter publishes after each fully successful run, and fires when none arrives for 3 hours (missing data breaching), instead of a gauge that counts up.
- **`smoke-billing` doesn't override plans**: its overage check is an opt-in `--overage` flag that really ingests 500,001 events, replacing §13's `--included`.
- **New free orgs get the new Free allowances right away** (2 members, 3 keys, 2 pending invites); existing free orgs move only when `apply-plan-limits` runs.
- **Monthly-only:** there are no annual prices or plans anywhere.
- **Custom orgs keep their legacy limits and 30-day retention**, including orgs an operator marks custom with `set-limits`, which now also sets `retention_days` to 30.
- **The period counter is released on any enqueue failure**, not only some, so a client's retry isn't charged twice.
- **`retention_days` is kept out of stored traces:** ingest stamps it on the queued event and the processor strips it before the hot store, query API and lake see it.
- **Deleter time budget and window** now reach `MAX_RETENTION_DAYS` + 2 days back, so 90-day Pro data is covered.
- **Plan switching moved from the Customer Portal to a console route** (`POST /v1/orgs/{id}/billing/change`); the Portal handles payment methods, invoices and cancellation.
- **The portal configuration is tagged and converged by `stripe-setup`**, which finds it by its metadata tag and adopts an older plan-switching one.
- **Stale and superseded subscription guards:** a late event for an old, terminal subscription, or a deletion of a superseded one, is ignored while the org holds a newer live subscription.
- **`paused` maps to Free**, since collection is paused and nothing is being paid for.
- **A spend-cap race guard:** BILLING's cap and PROFILE's derived `monthly_events` are written together, and the webhook re-reads if the cap changed under it.
- **The meter claims, then sends:** it records a `pending` event on BILLING before calling Stripe and re-sends exactly that event first on the next run; `reported_period` only moves forward; metering follows the Stripe period; event timestamps are clamped to the period end.
- **A durable `flush_due` marker** is written with the move off a period (or off a paid plan), so the final usage of a period can't be forgotten after a failed flush.
- **The webhook event record is a lease** (a retry gets 409 while one is in progress), and a missing subscription (404) is read as "deleted" only for deletion events.
- **One Stripe customer per org, and open Checkout sessions expire:** the first Checkout creates the customer (idempotent), and each new Checkout expires the org's other open sessions.
- **Timeouts:** the webhook Lambda runs for 60 s and the console's billing routes for 29 s.
- **The webhook-failure alarm uses a text log filter**, because Lambda's default log format isn't JSON.
- **The Stripe secret's name is CDK-generated** (a fixed name would collide with the retained secret on redeploy); operators use the `StripeSecretArn` output.
- **Deleting an org is refused while its subscription is open** (active, trialing, past_due, unpaid or incomplete): the deleter never touches Stripe, so the owner cancels in Manage billing first. The delete dialog says so.
- **`set-limits` refuses an org with an open subscription** ("cancel the Stripe subscription first") and removes `period_start`/`period_end` from PROFILE when marking it custom; `periodBounds` uses stored period fields only on Team and Pro, so custom and free orgs always count by UTC calendar month.
- **The Stripe secret is re-read every 5 minutes** (a failed re-read keeps the last good value), and the webhook forces one re-read on a signature mismatch before answering 400 (at most one forced re-read per 30 s per instance). No redeploy is needed for new keys.
- **`BillingWebhookSignatureRejected` alarm:** a text-term metric filter on "stripe webhook signature rejected", firing at 3 or more in 15 minutes, catches a wrong `webhook_secret`, which answers 400 and so never reaches the 500-based failure alarm.
- **BILLING and `STRIPE#…/CUSTOMER` record `livemode`;** records without it count as test mode. A record whose mode differs from the configured key's (`sk_test_` vs `sk_live_`) is treated as absent: Checkout creates a new customer (replacing the old record with an inert one), the meter skips it, GET billing shows no account, the portal and plan change refuse, and org deletion isn't blocked by it. The webhook answers events whose `livemode` differs from the key's with a 200 and ignores them. `applySubscription` replaces an other-mode BILLING record instead of carrying over its cap, counters, `pending` or `flush_due`.
- **Test-to-live reset:** `scripts/reset-test-billing.ts` (live key required, dry run unless `--apply`) moves every active Team or Pro org that no live subscription holds open to Free with `applySubscription(org, null)`. Its planner and argument checks are unit tested.
- **Paid plans are gated by `BILLING_CHECKOUT_ENABLED`**, set on the console Lambda only by CDK context `billingCheckout=true` (off by default). While off, Checkout and plan change answer 403 "paid plans aren't available yet", GET billing reports `checkout_enabled: false`, and the console hides the Upgrade and Switch buttons with a short note.
- **`stripe-setup` checks Stripe Tax** (`tax.settings.retrieve()`) and exits non-zero with what to configure (head office address, default tax behaviour) unless it is active or `--skip-tax-check` is given.
- **GET billing also returns `billing_account` and `subscription_status`** (the mode-matching BILLING record's, whatever the profile plan), so an org downgraded to Free can reach Manage billing and see a payment-problem banner. The portal opens for any org with a mode-matching customer.
- **Checkout's 409s:** BILLING `past_due`, `unpaid` or `incomplete` answers "there's a payment problem on your subscription — use Manage billing"; `active` or `trialing` answers "already subscribed, use Manage billing", as does any subscription Stripe lists for the customer in those five states (checked before each session, so a second Checkout can't be paid before the webhook lands). The console treats only the exact "already subscribed" answer as a subscription being set up, and hides the plan cards while it waits.
- **Paid judge ceiling:** paid, custom and legacy orgs together get at most `PAID_JUDGE_CALLS_PER_NIGHT` (1,000) judge calls a night, each scaled down in proportion (rounded down) when their allowances add up to more, with `GlobalCapHit` (`Cap=judge_paid`) and its own alarm. It exists for the single Step Functions execution's history limit; a Distributed Map (the eval-scaling follow-up) removes it.
- **Paid usage has its own counter:** `<org>#paid#<start>` for Team and Pro, `<org>#month#<start>` for free and custom. Ingest picks it from the tenant's plan, the meter always reads the paid one, and the usage route and GET billing from the profile's plan. Deploy this before any live paid org exists: a paid org's counter for the current period restarts at zero.
- **A NULL spend cap is matched by type:** `applySubscription`'s BILLING condition uses `attribute_not_exists(spend_cap_usd) OR attribute_type(spend_cap_usd, NULL)` when it read no cap, since DynamoDB never finds a stored NULL equal to a value.
- **`smoke-billing` checks Stripe's meter summary for the customer**, not what its own meter run sent (the hourly meter may already have sent some events); `--overage` waits for the summary to reach the full count.
- **Runbook notes** (README): investigate a meter `pending` older than a few hours (Stripe dedupes identifiers for at least 24 h); operator cancellations use `invoice_now: true`; subscribing the webhook to `v1.billing.meter.error_report_triggered` is a follow-up.
- **Open:** the Enterprise "Contact us" has no contact address yet; it stays plain text until one is decided.
