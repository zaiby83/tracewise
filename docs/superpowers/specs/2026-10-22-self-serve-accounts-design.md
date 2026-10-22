# Self-serve accounts and console: design

**Status:** Approved design, pending spec review · **Date:** 2026-10-22 · **Related:** [design document](../../design.md), [PR/FAQ](../../PRFAQ.md)

## 1. Intent

Tracewise today has no accounts, only API keys that an operator creates by running `pnpm tenant:create`. This work makes it self-serve, as groundwork for a real product: a team signs up, creates an organisation, gets a key, sends traces and manages its account without anyone running a script.

**What was decided**
- The audience is a path to a product. That means organisations with members, with room for SSO and billing later without a data migration. SSO and billing are not built now.
- Sign-up is open to anyone with a verified email, and every new org gets free-tier caps.
- The first release includes key management, eval rubric settings, team members and invites, and usage, limits and org deletion.
- Installable SDKs (npm and Python) are a separate spec that comes next. The console's quickstart uses the HTTP API, which works today.
- Approach A: Cognito plus JWT-authorized routes on the existing HTTP API, and a plain-JS console in the existing dashboard bundle. No framework and no build step.
- Invites are copyable links. Email delivery through SES can be added later without changing the data model.

**What success looks like**
- A new user goes from the public demo page, through sign-up, to a trace visible in their own console in under five minutes, with no operator involved.
- One person creating many orgs can't push nightly Bedrock spend or daily ingest past fixed global caps.
- The public demo, its read-only key, the existing API-key routes and the data lake's tenant isolation work as they do today.

**Non-goals for this spec:** billing, SSO/SAML, emailing invites, publishing the SDKs, a Python SDK, audit logs, and orgs choosing their own retention.

## 2. Identity

- One Cognito user pool. Users sign in with email, the email must be verified before an org can be created, and MFA is optional (TOTP).
- Cognito Managed Login hosts sign-up, sign-in, password reset and MFA, so the console builds no credential screens.
- The console is a public app client using the authorization-code flow with PKCE. Callback and sign-out URLs are `/console/callback` and `/console/` on the CloudFront domain. Access and ID tokens are kept in memory, and the refresh token in `sessionStorage`. The refresh token lasts 30 days and is rotated.
- Cognito answers *who you are* and nothing more. Org membership and roles live in DynamoDB (section 3). Cognito groups are not used: they would have to be created per org, and they can't hold a different role per org.
- An HTTP API JWT authorizer validates tokens against the pool's issuer, with the console client ID as the audience. Handlers read `sub`, `email` and `email_verified` from the claims.

## 3. Data model

### 3.1 `Accounts` table (new)

A single-table design with `pk` and `sk`, on-demand billing, TTL on `expires_at`, and AWS-managed encryption, like the other tables.

| pk | sk | Attributes |
|---|---|---|
| `ORG#<org_id>` | `PROFILE` | `name`, `status` (`active` \| `suspended` \| `deleting` \| `deleted`), `plan` (`free` \| `custom`), `limits` (section 5), `rubric` (string or null), `evals_enabled` (bool), `created_at`, `created_by`, `deleted_at` |
| `ORG#<org_id>` | `MEMBER#<sub>` | `email`, `role` (`owner` \| `member`), `joined_at` |
| `USER#<sub>` | `ORG#<org_id>` | `role`, `org_name`: the reverse lookup behind "my orgs" |
| `ORG#<org_id>` | `KEY#<key_id>` | `name`, `scope` (`read` \| `write`), `prefix` (the first 8 characters, e.g. `tw_ab12cd`), `key_hash`, `created_by`, `created_at`, `last_used_at`, `revoked_at` |
| `ORG#<org_id>` | `INVITE#<invite_id>` | `token_hash`, `email`, `role`, `created_by`, `created_at`, `expires_at` (7 days, TTL) |
| `INVITE#<token_hash>` | `INVITE` | `org_id`, `invite_id`, `expires_at`: lets accept find the invite by token |

- The `MEMBER` and `USER` items are always written and deleted together in one `TransactWriteItems`, and so are the two invite items.
- `org_id` for orgs that already exist is their current `tenant_id`, and new orgs get a fresh UUID. Trace partition keys, S3 prefixes (`tenant_id=<org_id>`), the Glue projection and eval runs all keep the name `tenant_id`. Renaming it would touch the data lake for no gain.

### 3.2 `Tenants` table becomes the key index

The table keeps its name and its `key_hash` partition key (renaming it would replace the table). Rows shrink to:

```
{ key_hash, org_id, key_id, scope, status: "active" | "revoked" }
```

The tenant record is no longer copied onto every key row, so changing a rubric or a limit is one write to `PROFILE`.

### 3.3 Authenticating an API-key request

`tenantForKey(apiKey)` reads the key-index row and then the org's `PROFILE`, and caches both per Lambda instance for 60 s, as it does today. It returns a tenant only when the key is `active` and the org is `active`. So revoking a key, suspending an org or deleting one takes up to 60 s to apply everywhere, which is the trade already documented in `tenants.ts`.

The `Tenant` type it returns gains `org_id`, `key_id`, `limits`, `rubric` and `evals_enabled`. `tenant_id` stays as an alias of `org_id` so existing callers don't change.

## 4. Control-plane API

Every route in this section is on the existing HTTP API behind the JWT authorizer and is served by one new `console` Lambda with a small path router. Request bodies are validated with zod, as in `schema.ts`.

**Membership check.** Every `/v1/orgs/{orgId}/…` handler first reads `ORG#orgId / MEMBER#<sub>` (not cached). If you aren't a member, or the org is `deleting` or `deleted`, the response is **404 `{ error: "not found" }`**, never 403, so the API never confirms that an org exists. A member calling an owner-only route gets 403.

| Method and path | Role | Behaviour |
|---|---|---|
| `GET /v1/orgs` | signed in | Query `USER#<sub>` → `[{ org_id, name, role }]` |
| `POST /v1/orgs` `{ name }` | signed in, `email_verified` | Checks the per-user and global caps (section 5). In one transaction it creates the `PROFILE` (plan `free`, default limits, `evals_enabled: true`, `rubric: null`) and the owner's `MEMBER`/`USER` items, then creates a first write key named "Default". Returns the org and the key secret, shown once |
| `GET /v1/orgs/{id}` | member | Profile, limits and your role |
| `PATCH /v1/orgs/{id}` `{ name?, rubric?, evals_enabled? }` | owner | Name 1–100 characters, rubric ≤ 4,000 characters or null (null means the default rubric). A rename also updates `org_name` on every member's `USER` item |
| `DELETE /v1/orgs/{id}` `{ confirm_name }` | owner | `confirm_name` must match the org name. Sets `status: deleting` and starts the deleter (section 6). Returns 202 |
| `GET /v1/orgs/{id}/keys` | member | Keys that aren't revoked: id, name, scope, prefix, created_by, created_at, last_used_at |
| `POST /v1/orgs/{id}/keys` `{ name, scope }` | member | Checks the key cap. Writes the `KEY` item and the key-index row together. Returns the secret once |
| `DELETE /v1/orgs/{id}/keys/{keyId}` | member | Sets `revoked_at` on the `KEY` item and `status: revoked` on the key-index row |
| `GET /v1/orgs/{id}/members` | member | id, email, role, joined_at |
| `PATCH /v1/orgs/{id}/members/{sub}` `{ role }` | owner | Change a role. Refused if it would leave no owner. Transferring ownership is promoting another member to owner and then demoting yourself |
| `DELETE /v1/orgs/{id}/members/{sub}` | owner, or yourself | Refused if it would leave no owner |
| `POST /v1/orgs/{id}/invites` `{ email, role }` | owner | Checks the pending-invite and member caps. Creates a 256-bit token and stores only its SHA-256 hash. Returns `{ invite_id, link: "<origin>/console/#/invite/<token>", expires_at }` once |
| `GET /v1/orgs/{id}/invites` | owner | Pending invites: id, email, role, expires_at |
| `DELETE /v1/orgs/{id}/invites/{inviteId}` | owner | Revokes the invite by deleting both items |
| `POST /v1/invites/accept` `{ token }` | signed in | Looks up `INVITE#<hash>`. Requires that it hasn't expired, that `email_verified` is true, and that the token's email matches the invite's email (case-insensitive). Adds the member and deletes the invite in one transaction. A wrong, expired or already-used token returns 404 |
| `GET /v1/orgs/{id}/usage` | member | Today's and this minute's event counts, eval samples used last night, analytics queries today, and counts of keys, members and invites, each against its limit |

**Console access to trace data.** These JWT-protected routes are served by the Lambdas that already serve the key-authenticated routes:

| JWT route (new) | Lambda | Same as |
|---|---|---|
| `GET /v1/orgs/{id}/traces` | query | `GET /v1/traces` |
| `GET /v1/orgs/{id}/analytics/summary` | analytics | `GET /v1/analytics/summary` |
| `GET /v1/orgs/{id}/evals` | evalsApi | `GET /v1/evals` |

A shared `resolveTenant(event)` in `services/shared/auth.ts` returns the tenant one of two ways:
- with JWT claims on the request context: from the `{id}` path parameter and a membership check
- otherwise: from the bearer API key through `tenantForKey`

The query code after that, including Athena's tenant-filter enforcement, doesn't change. The key-authenticated routes, `/v1/me` and the public demo keep working as they are.

## 5. Limits

### 5.1 Per-org limits, on `PROFILE.limits`

| Limit | Free default | Enforced in |
|---|---|---|
| `events_per_minute` | 600 | ingest, the existing `consumeQuota` window |
| `events_per_day` | 50,000 | ingest, a second counter `"<org>#day#<YYYY-MM-DD>"` in the Quotas table, TTL 2 days |
| `eval_samples_per_night` | 20 | eval `sample` step (`min(limit, SAMPLE_SIZE)`), skipped when `evals_enabled` is false |
| `analytics_queries_per_day` | 200 | analytics Lambda, a counter `"<org>#athena#<YYYY-MM-DD>"` |
| `max_keys` / `max_members` / `max_pending_invites` | 10 / 5 / 10 | console Lambda |

- The ingest check runs the per-minute update first and then the daily update. If the daily update fails, the minute window has slightly over-counted, which is acceptable.
- When the daily cap is reached, ingest returns `429 { error: "daily event cap reached" }` with `retry-after` set to the seconds until UTC midnight and `x-tracewise-limit: daily`. The per-minute 429 gains `x-tracewise-limit: minute`.
- Operators raise limits by editing `PROFILE.limits`, through `scripts/set-limits.ts "<org name or id>" key=value…`, which also sets `plan: custom`.

### 5.2 Global caps

- **New orgs:** at most 3 orgs owned per user (counted from `USER#<sub>` items with role owner) and at most 100 new orgs per UTC day across the service (counter `global#orgs#<day>`). Above either cap: `429 { error: "sign-ups are paused, try again tomorrow" }`.
- **Judge calls:** at most 2,000 per night across all orgs. `listTenants` gives each org `min(org limit, floor(2000 / active orgs with evals enabled))`. An org that gets fewer than its limit has the shortfall recorded on its eval run.
- Hitting any global cap publishes a CloudWatch metric, and an alarm sends it to the existing SNS topic.

## 6. Data-plane changes

- **Ingest:** `tenantForKey` as in section 3.3, plus the daily counter from section 5.1.
- **`last_used_at`:** ingest and query update `KEY#<key_id>.last_used_at` at most once an hour per key per Lambda instance, without waiting for the write and ignoring its errors, so ingest latency doesn't change.
- **Evals `listTenants`:** scans `Accounts` for `sk = PROFILE`, `status = active` and `evals_enabled = true`, and returns the rubric and the sample budget. The de-duplication across key rows goes away. A scan is fine at this scale, and a sparse GSI on active profiles can replace it later.
- **Org deletion**, carried out by a new `deleter` Lambda triggered by a new SQS queue:
  1. `DELETE /v1/orgs/{id}` sets `status: deleting` and enqueues `{ org_id, phase: "dynamo" }`. Keys stop working within 60 s because the org is no longer active.
  2. `dynamo` phase: deletes trace items for the last `HOT_RETENTION_DAYS` days across all shards (`partitionsForDay`, BatchWrite with retries), then eval runs. Each message handles a bounded chunk and re-enqueues itself with a cursor until done.
  3. `s3` phase: lists `traces/tenant_id=<org_id>/` and calls `DeleteObjects` 1,000 keys at a time, re-enqueuing with a continuation token.
  4. `sweep` phase: one more S3 pass, enqueued with a 900 s delay, to catch records Firehose was still buffering.
  5. `accounts` phase: deletes key-index rows, `KEY`, `MEMBER`, `USER` and `INVITE` items. It then sets `PROFILE` to `status: deleted` with `deleted_at` and clears `rubric`, leaving that tombstone as the record of the deletion.
  - Failures retry through the queue, which dead-letters after 5 attempts. The dead-letter queue has an alarm, like the ingest one.

## 7. Console

Plain HTML, CSS and ES modules in `dashboard/console/`, with no dependencies or build step. It uses the same `tokens.css` and `components.css` as the demo.

| Module | Responsibility |
|---|---|
| `auth.js` | PKCE: generate the verifier and state, redirect to Managed Login, exchange the code at `/console/callback`, refresh silently before tokens expire, sign out |
| `api.js` | `fetch` wrapper: adds `Authorization: Bearer <access token>`, prefixes `/v1/orgs/<current org>`, refreshes once on 401, turns errors into messages people can read |
| `router.js` | Hash routes: `#/orgs/new`, `#/overview`, `#/traces`, `#/keys`, `#/team`, `#/usage`, `#/settings`, `#/invite/<token>` |
| `views/*.js` | One module per screen |

**Screens:**
- **Create org**: shown when `GET /v1/orgs` is empty.
- **Overview**: the endpoint URL, the first key shown once with a copy button and a warning, a curl quickstart filled in with your endpoint, and SDK tabs marked "coming soon".
- **Traces & analytics**: the demo's views, pointed at the JWT routes.
- **Keys**: create, list and revoke. The secret appears in a dialog once.
- **Team**: members, roles, pending invites, and creating an invite with a copyable link.
- **Usage**: one bar per limit, plus what happens at each cap.
- **Settings**: name, a rubric editor that shows the default rubric when empty, the evals toggle, and a danger zone for deleting the org by typing its name.
- **Invite accept**: signs you in if needed, then accepts.
- An org switcher sits in the header when you belong to more than one org.

**Shared code.** The chart, table and formatting functions in `dashboard/app.js` move to `dashboard/shared/`, so the demo and the console render traces with one implementation. The demo's behaviour doesn't change apart from a "Sign up" link in its header.

**Safety.** Every value from the API is rendered as text, as the demo does. A new CloudFront response-headers policy on `/console/*` matches the demo's CSP except that `connect-src` also allows the Cognito domain, which the token exchange needs. Nothing else is loosened.

## 8. Infrastructure and IAM

New CDK resources, kept in a new `infra/lib/accounts.ts` construct, following `analytics.ts`, `evals.ts` and `dashboard.ts`:
- the user pool, its domain and the console client
- the JWT authorizer
- the `Accounts` table
- the console Lambda and its routes
- the deletion queue with its dead-letter queue and alarm
- the deleter Lambda
- the console behaviour and its CSP policy

| Function | Access |
|---|---|
| console | Accounts (read/write), key index (read/write), Quotas (read/write). **No access to traces, S3 or eval runs.** |
| deleter | Delete on traces, eval runs, Accounts and key index; list and delete on the data-lake bucket's `traces/` prefix; send on its own queue |
| ingest | Unchanged, plus read on Accounts and update on `KEY` items for `last_used_at` |
| query, analytics, evalsApi | Plus read on Accounts, for the membership check and `PROFILE` |
| eval workflow | Read on Accounts instead of scanning the key index |

CDK assertion tests enforce the console and deleter rows and the existing rule that ingest can't read traces.

## 9. Testing

**Unit (vitest)**, alongside `test/*.spec.ts`:
- **Authorization:** a non-member gets 404 on every org route. A member gets 403 on every owner-only route. An org that is `deleting` returns 404.
- **Owner rules:** demoting or removing the last owner is refused, and transferring ownership works.
- **Invites:** a mismatched email, an unverified email, an expired token, a reused token and a revoked invite all return 404, and a valid one adds the member exactly once.
- **Keys:** the secret appears only in the create response, and revoking marks both the `KEY` item and the key-index row.
- **Limits:** daily-cap headers and retry-after, the per-user and global org caps, the share-out of the judge budget, and the analytics query cap.
- **`resolveTenant`:** key path, JWT path, a JWT for an org you aren't a member of, a revoked key and a suspended org.
- **Deleter:** each phase's chunking and cursors, the delayed sweep being enqueued, and the tombstone.
- **Migration:** idempotent across two runs, and keeps existing quotas.

**CDK assertions:** every `/v1/orgs/*` and `/v1/invites/*` route has the JWT authorizer, the existing key routes don't, and the IAM rules in section 8 hold.

**Smoke (`scripts/smoke.ts`):** when deployed with the `smokeClient=true` context, CDK adds an app client that allows `ADMIN_USER_PASSWORD_AUTH`. It's never added by default. The self-serve smoke path:
1. Creates a test user with `AdminCreateUser` and `AdminSetUserPassword`, and gets tokens.
2. Creates an org.
3. Ingests with its key.
4. Reads the trace through `/v1/orgs/{id}/traces`.
5. Creates and accepts an invite with a second test user.
6. Revokes the key and checks for 401 after the cache window.
7. Deletes the org and checks that its traces and S3 prefix are gone after the sweep.
8. Deletes the test users.

## 10. Rollout

1. **Deploy code that reads both key-row shapes.** If a key-index row has no `org_id`, `tenantForKey` falls back to the old fields on the row. `listTenants` reads profiles from `Accounts` plus any old-shape tenants that don't have a profile yet.
2. **Run `scripts/migrate-accounts.ts [--owner you@example.com]`.** For each distinct `tenant_id` in the key index it does three things. It creates `PROFILE` if missing (plan `custom`, `events_per_minute` from the existing row, the other limits at the free defaults, the existing `rubric`). It writes a `KEY` item and rewrites the row to the lean shape. And it optionally adds the given Cognito user as owner. Running it again changes nothing. The demo tenant keeps its read-only dashboard key.
3. **Follow-up change:** remove the old-shape fallback.

`create-tenant.ts` and `create-key.ts` become thin wrappers around the same functions the console API uses, so operators and customers create orgs and keys the same way.

**Docs:**
- README: sign-up, the console, and limits
- `design.md`: identity, the accounts model, and self-serve moved from non-goal to done
- `experiments.md`: if the auth change measurably moves ingest latency, measure it again

## 11. Open items for later specs

- **SDK spec:** build and publish `@tracewise/sdk`, write a Python SDK, and make the SDK stop retrying on `x-tracewise-limit: daily`.
- **Invite emails:** send through SES once a domain is verified and SES production access is granted. The `INVITE` items already hold everything needed.
- **Billing and plans:** `plan` and `limits` already sit on `PROFILE`, ready for them.
- **SSO:** Cognito SAML/OIDC identity providers, mapped to orgs by email domain.
- **Audit log** for key, member and settings changes.
