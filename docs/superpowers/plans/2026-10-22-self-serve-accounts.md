# Self-serve accounts and console: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can sign up, create an organisation, get an API key, send traces and manage keys, team, rubric, usage and deletion from a console, with free-tier and global caps, and with no operator involved.

**Architecture:**
- Cognito Managed Login issues ID tokens.
- An HTTP API JWT authorizer protects new `/v1/orgs/*` and `/v1/invites/*` routes, all served by one `console` Lambda.
- A new single-table `Accounts` DynamoDB table holds orgs, members, keys and invites, and the existing `Tenants` table becomes a slim key index.
- The data plane (ingest, query, analytics, evals) changes only where it resolves a tenant and applies limits.
- Deletion runs in a separate, queue-driven `deleter` Lambda.
- The console is plain ES modules under `dashboard/console/`, served by the existing CloudFront distribution.

**Tech Stack:** TypeScript (strict, ESM), Node 22 Lambdas on arm64, AWS CDK v2 (`aws-cdk-lib` 2.274.0), DynamoDB (`@aws-sdk/lib-dynamodb` 3.1155.0), Cognito, API Gateway HTTP API, SQS, S3, CloudFront, vitest 5, zod 4, and plain browser JS with no build step.

**Spec:** [docs/superpowers/specs/2026-10-22-self-serve-accounts-design.md](../specs/2026-10-22-self-serve-accounts-design.md). Read it alongside this plan. The section "Decisions made while planning" below records where this plan refines it.

## Decisions made while planning

These refine the spec. Task 15 adds them to the spec as a short "Changes during planning" section.

1. **The console sends the Cognito ID token, not the access token.** Cognito access tokens carry no `email` or `email_verified` claims, and invite acceptance needs both. ID tokens have `aud` = client id, which the JWT authorizer checks.
2. **Callback and sign-out URL is `<origin>/console/index.html`.** S3 behind OAC doesn't serve directory index files, and using the file path avoids adding a CloudFront Function.
3. **Migrated orgs keep today's behaviour:** `legacyLimits(epm)` sets `events_per_day = epm × 1440` and `analytics_queries_per_day = 10_000`. Free defaults would have capped the public demo (polled every minute) and the 751k-event load test, and the spec requires both to keep working.
4. **`PROFILE.owner_count`** is kept atomically, and transactions use the condition `owner_count > 1` when an owner is demoted or removed. This makes the "at least one owner" rule safe under concurrency.
5. **The `Accounts` table is declared in the stack's Storage section**, like the other tables. `infra/lib/accounts.ts` holds Cognito, the console and deleter functions, routes and alarms.
6. **The eval `sample` step writes the night's sample count to the Quotas table** (`<org>#evals#<day>`). The usage route can then read it without eval-runs access. The console Lambda also needs SQS send on the deletion queue and `cloudwatch:PutMetricData` on `Tracewise/Limits`.
7. **Key, member and invite caps return `409 { error, limit }`.**
8. **The self-serve smoke test is a separate `scripts/smoke-selfserve.ts`**, so `smoke.ts` keeps working with only a key.
9. **The key display prefix is the first 9 characters** (`tw_` + 6), matching the spec's example `tw_ab12cd`.
10. **CloudFront gets uncached behaviours `/v1/orgs*` and `/v1/invites/*`** ahead of `/v1/*`. The existing `/v1/*` cache keys on `authorization`, which would serve stale key lists after a create.
11. **The deleter removes DynamoDB trace days 0 to `HOT_RETENTION_DAYS + 2`**, to cover TTL lag. `errors/` and `athena-results/` in the lake aren't deleted, because they expire by lifecycle (14 and 7 days) and hold malformed records and aggregates, not trace partitions. The README says so.

## Global Constraints

- Node 22, TypeScript strict with `noUncheckedIndexedAccess`, ESM, tab indentation, and comment density like the surrounding files.
- **New packages:** only two, both AWS SDK clients pinned at `3.1155.0` and added to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` like the others: `@aws-sdk/client-s3` (a runtime dependency, for the deleter) and `@aws-sdk/client-cognito-identity-provider` (a dev dependency, for scripts). JWT handling needs no library, because API Gateway verifies tokens and handlers only read claims.
- **Dashboard and console:** no build step, no third-party scripts, no inline script, and every API value rendered as text (`textContent` through `el()`, never `innerHTML`).
- **Free limits (exact):** `events_per_minute` 600, `events_per_day` 50,000, `eval_samples_per_night` 20, `analytics_queries_per_day` 200, `max_keys` 10, `max_members` 5, `max_pending_invites` 10.
- **Global caps (exact):** `MAX_OWNED_ORGS` 3, `GLOBAL_ORGS_PER_DAY` 100, `GLOBAL_JUDGE_CALLS_PER_NIGHT` 2,000.
- **Validation limits:** org name 1–100 characters, rubric ≤ 4,000 characters or null, invites expire after 7 days, invite tokens are 256-bit with only the SHA-256 hash stored, and the refresh token lasts 30 days.
- **Response rules:**
  - Non-members and orgs that are `deleting`/`deleted` get `404 { error: "not found" }`.
  - Members on owner-only routes get `403 { error: "owner only" }`.
  - Key secrets and invite tokens are returned only in their create response.
- **Ingest 429s:** `x-tracewise-limit: minute|day`. The daily one has `retry-after` set to the seconds until UTC midnight.
- **Commit messages:** plain sentences like the existing history ("Polish the dashboard"), on branch `self-serve-accounts`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Cognito's built-in email sender is limited to 50 emails a day.** Verification emails count against it. That's acceptable for launch, and the README documents it next to the SES follow-up.

## Review Focus

1. **The public demo after migration.** Its read-only key polls analytics all day, so it must not hit a 200/day cap. Covered by `legacyLimits` and a migration test (Task 14).
2. **CloudFront caching console responses.** A `GET /v1/orgs/{id}/keys` cached per `authorization` header would hide a key just created. `/v1/orgs*` and `/v1/invites/*` must use CachingDisabled and come before `/v1/*`. Covered by a CDK test (Task 10).
3. **Invite email case and whitespace.** An invite to `" Alice@Example.com"` must be accepted by a user whose claim is `alice@example.com`. Emails are trimmed and lowercased on create and compare. Covered by a store test (Task 5) and a handler test (Task 6).
4. **Two owners demoting each other at once.** That must never leave zero owners. A `ConditionalCheckFailed` on `owner_count` becomes `"last_owner"`. Covered by a store test (Task 5).
5. **An ID token expiring mid-session.** The console must refresh once and retry once on 401, and only then send the user to sign in. Covered by an `api.js` test (Task 12).

---

## File structure

| File | Responsibility |
|---|---|
| `services/shared/accounts.ts` (new) | Accounts types, limit constants, key builders, and the reads the data plane needs |
| `services/shared/tenants.ts` (modify) | `Tenant` built from the key index and profile, with the legacy fallback; generic counters; minute and day quotas |
| `services/shared/auth.ts` (new) | `jwtClaims`, `resolveTenant` (API key or JWT + membership) |
| `services/console/store.ts` (new) | Every Accounts write: orgs, keys, members, invites, deletion start |
| `services/console/route-keys.ts` (new) | The exact route-key strings, shared by the handler and CDK |
| `services/console/handler.ts` (new) | Router keyed by `event.routeKey`; claims, membership, role checks and body parsing |
| `services/console/routes/{orgs,keys,team,usage}.ts` (new) | Route implementations, each exporting part of the route table |
| `services/deleter/handler.ts` (new) | SQS-driven org deletion in phases with cursors |
| `services/ingest/handler.ts`, `query/handler.ts`, `analytics/handler.ts`, `evals/api.ts`, `evals/handlers.ts` (modify) | New tenant resolution, limits, eval budget |
| `infra/lib/accounts.ts` (new) | Cognito, the console and deleter functions, the authorizer and routes, the deletion queue, alarms |
| `infra/lib/tracewise-stack.ts`, `infra/lib/dashboard.ts`, `infra/bin/tracewise.ts`, `infra/lib/evals.ts` (modify) | Wiring, CloudFront behaviours, console CSP, config |
| `dashboard/shared/{dom,format,charts}.js` (new) | Code moved out of `app.js`, used by the demo and the console |
| `dashboard/console/*` (new) | `index.html`, `console.css`, `auth.js`, `api.js`, `router.js`, `app.js`, `views/*.js` |
| `scripts/lib/migrate.ts`, `scripts/migrate-accounts.ts`, `scripts/set-limits.ts`, `scripts/smoke-selfserve.ts` (new); `scripts/create-tenant.ts`, `scripts/create-key.ts` (modify) | Operator tooling |

---

### Task 1: Accounts types, limits and reads

**Files:**
- Create: `services/shared/accounts.ts`, `services/shared/ddb.ts`
- Modify: `services/shared/tenants.ts`. Move the `ddb` client into `ddb.ts`, and keep `export { ddb } from "./ddb"` here so existing imports and the `processor.spec.ts` mock keep working. This avoids a circular import: `tenants.ts` will import `accounts.ts` in Task 2.
- Test: `test/accounts.spec.ts`

**Interfaces:**
- Produces:
  - `type Role = "owner" | "member"`
  - `type OrgStatus = "active" | "suspended" | "deleting" | "deleted"`
  - `interface Limits { events_per_minute; events_per_day; eval_samples_per_night; analytics_queries_per_day; max_keys; max_members; max_pending_invites }`, all `number`
  - `FREE_LIMITS: Limits`
  - `MAX_OWNED_ORGS = 3`, `GLOBAL_ORGS_PER_DAY = 100`, `GLOBAL_JUDGE_CALLS_PER_NIGHT = 2000`, `INVITE_TTL_DAYS = 7`
  - `legacyLimits(eventsPerMinute: number): Limits`
  - `interface OrgProfile { org_id; name; status: OrgStatus; plan: "free" | "custom"; limits: Limits; rubric: string | null; evals_enabled: boolean; owner_count: number; created_at; created_by; deleted_at?: string }`
  - `interface Member { org_id; sub; email; role: Role; joined_at }`
  - `interface KeyRecord { org_id; key_id; name; scope: "read" | "write"; prefix; key_hash; created_by; created_at; last_used_at?: string; revoked_at?: string }`
  - `interface Invite { org_id; invite_id; token_hash; email; role: Role; created_by; created_at; expires_at: number }`
  - `interface KeyIndexRow { key_hash; org_id; key_id; scope: "read" | "write"; status: "active" | "revoked" }`
  - `k = { org(id), user(sub), member(sub), key(id), invite(id), inviteToken(hash) }`, returning `ORG#…`, `USER#…`, `MEMBER#…`, `KEY#…`, `INVITE#…`, `INVITE#…`
  - `getProfile(orgId): Promise<OrgProfile | null>`
  - `getMember(orgId, sub): Promise<Member | null>`
  - `listUserOrgs(sub): Promise<{ org_id: string; name: string; role: Role }[]>`
  - `listActiveProfiles(): Promise<OrgProfile[]>`
  - `touchKey(orgId: string, keyId: string, now = Date.now()): void`
  - `normalizeEmail(e: string): string`, which trims and lowercases
  - All reads and writes use the `ddb` from `services/shared/ddb.ts` and `process.env.ACCOUNTS_TABLE`.

- [ ] **Step 1: Write the failing tests** in `test/accounts.spec.ts`, mocking `../services/shared/ddb` with `{ ddb: { send: vi.fn() } }`, the same way `test/processor.spec.ts` mocks `tenants`.

```ts
it("free limits match the spec", () => {
	expect(FREE_LIMITS).toEqual({ events_per_minute: 600, events_per_day: 50_000, eval_samples_per_night: 20, analytics_queries_per_day: 200, max_keys: 10, max_members: 5, max_pending_invites: 10 });
});
it("legacy limits keep a migrated tenant's current behaviour", () => {
	expect(legacyLimits(6000)).toMatchObject({ events_per_minute: 6000, events_per_day: 6000 * 1440, analytics_queries_per_day: 10_000, eval_samples_per_night: 20 });
});
it("getProfile reads ORG#id / PROFILE and returns null when missing", async () => {
	ddb.send.mockResolvedValueOnce({ Item: undefined });
	expect(await getProfile("o1")).toBeNull();
	expect(ddb.send.mock.calls[0]![0].input).toMatchObject({ Key: { pk: "ORG#o1", sk: "PROFILE" } });
});
it("listUserOrgs queries USER#sub and maps items", async () => {
	ddb.send.mockResolvedValueOnce({ Items: [{ pk: "USER#u", sk: "ORG#o1", role: "owner", org_name: "Acme" }] });
	expect(await listUserOrgs("u")).toEqual([{ org_id: "o1", name: "Acme", role: "owner" }]);
});
it("listActiveProfiles pages through a scan and keeps only active profiles", async () => {
	ddb.send
		.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "a", status: "active" }], LastEvaluatedKey: { pk: "x" } })
		.mockResolvedValueOnce({ Items: [{ sk: "PROFILE", org_id: "b", status: "deleting" }] });
	expect((await listActiveProfiles()).map((p) => p.org_id)).toEqual(["a"]);
});
it("touchKey writes at most once an hour per key, without throwing", async () => {
	ddb.send.mockRejectedValue(new Error("boom"));
	const t = Date.parse("2026-10-22T10:00:00Z");
	touchKey("o", "k", t); touchKey("o", "k", t + 59 * 60_000); touchKey("o", "k", t + 61 * 60_000);
	await new Promise((r) => setTimeout(r, 0));
	expect(ddb.send).toHaveBeenCalledTimes(2);
});
it("normalizes emails", () => expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com"));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/accounts.spec.ts`
Expected: FAIL, "Failed to resolve import ../services/shared/accounts".

- [ ] **Step 3: Implement `services/shared/accounts.ts`** with the interfaces above.
  - `listUserOrgs` queries `pk = USER#sub` with `begins_with(sk, "ORG#")`.
  - `listActiveProfiles` scans with `FilterExpression: "sk = :p AND #s = :active"` and pages on `LastEvaluatedKey`.
  - `touchKey` keeps a per-instance `Map<keyId, lastWriteMs>`. It sends `UpdateCommand SET last_used_at = :now` with `ConditionExpression: "attribute_exists(pk)"`, and catches and ignores every error.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/accounts.spec.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add services/shared/accounts.ts services/shared/ddb.ts services/shared/tenants.ts test/accounts.spec.ts
git commit -m "Add the accounts model: types, free-tier limits and reads"
```

---

### Task 2: Tenant resolution from the key index, counters and daily quota

**Files:**
- Modify: `services/shared/tenants.ts`, `services/ingest/handler.ts`
- Test: `test/tenants.spec.ts` (new), `test/ingest.spec.ts` (update the fixture and 429 test)

**Interfaces:**
- Consumes: Task 1's `getProfile`, `legacyLimits`, `Limits`, `touchKey`.
- Produces:
  - `interface Tenant { tenant_id: string; org_id: string; key_id?: string; name: string; status: "active"; scope?: "read" | "write"; limits: Limits; rubric: string | null; evals_enabled: boolean }`. The `events_per_minute` field is removed, and `tenant_id === org_id`.
  - `tenantForKey(apiKey): Promise<Tenant | null>` (same name, new behaviour)
  - `consumeCounter(id: string, n: number, max: number, expiresAt: number): Promise<boolean>`
  - `readCounter(id: string): Promise<number>`
  - `counterIds = { minute(org, now), day(org, now), athena(org, now), evals(org, day), globalOrgs(now) }`, returning `"<org>#<minute>"` (unchanged format), `"<org>#day#YYYY-MM-DD"`, `"<org>#athena#YYYY-MM-DD"`, `"<org>#evals#YYYY-MM-DD"`, `"global#orgs#YYYY-MM-DD"`
  - `type QuotaResult = "ok" | "minute" | "day"`
  - `consumeQuota(tenant, events, now = Date.now()): Promise<QuotaResult>`
  - `secondsUntilUtcMidnight(now = Date.now()): number`

- [ ] **Step 1: Write the failing tests** in `test/tenants.spec.ts`, mocking `@aws-sdk/lib-dynamodb`'s client through `vi.spyOn(DynamoDBDocumentClient.prototype, "send")`. Mock `../services/shared/accounts`'s `getProfile` with `vi.mock`, keeping the real `legacyLimits`.

```ts
it("resolves a new-shape key row through the org profile", async () => {
	send.mockResolvedValueOnce({ Item: { key_hash: "h", org_id: "o1", key_id: "k1", scope: "write", status: "active" } });
	accounts.getProfile.mockResolvedValueOnce({ org_id: "o1", name: "Acme", status: "active", limits: FREE_LIMITS, rubric: null, evals_enabled: true });
	expect(await tenantForKey(newApiKey())).toMatchObject({ tenant_id: "o1", org_id: "o1", key_id: "k1", limits: FREE_LIMITS });
});
it.each([
	["revoked key", { status: "revoked" }, { status: "active" }],
	["suspended org", {}, { status: "suspended" }],
	["deleting org", {}, { status: "deleting" }],
])("returns null for a %s", async (_n, row, profile) => { /* row + profile merged over the active fixtures → null */ });
it("falls back to an old-shape row that has no org_id yet", async () => {
	send.mockResolvedValueOnce({ Item: { key_hash: "h", tenant_id: "t1", name: "Demo", status: "active", events_per_minute: 6000, scope: "read" } });
	expect(await tenantForKey(newApiKey())).toMatchObject({ tenant_id: "t1", org_id: "t1", scope: "read", limits: legacyLimits(6000) });
	expect(accounts.getProfile).not.toHaveBeenCalled();
});
it("consumeQuota reports which window refused", async () => {
	const t = { ...tenant, limits: { ...FREE_LIMITS, events_per_minute: 10, events_per_day: 15 } };
	send.mockResolvedValueOnce({}).mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
	expect(await consumeQuota(t, 5)).toBe("day");
	send.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
	expect(await consumeQuota(t, 5)).toBe("minute");
});
it("names counters by day in UTC", () => {
	expect(counterIds.day("o", Date.parse("2026-10-22T23:59:00Z"))).toBe("o#day#2026-10-22");
	expect(counterIds.globalOrgs(Date.parse("2026-10-22T01:00:00Z"))).toBe("global#orgs#2026-10-22");
});
it("counts seconds to UTC midnight", () => expect(secondsUntilUtcMidnight(Date.parse("2026-10-22T23:59:00Z"))).toBe(60));
```

In `test/ingest.spec.ts`:
- Change the fixture to `{ tenant_id: "tenant-1", org_id: "tenant-1", key_id: "k1", name: "Acme", status: "active", limits: FREE_LIMITS, rubric: null, evals_enabled: true }`.
- Make the mocked `consumeQuota` resolve `"ok"`.
- Replace the 429 test with:

```ts
it.each([["minute", "60"], ["day", expect.stringMatching(/^\d+$/)]])("returns 429 naming the %s limit", async (limit, retry) => {
	tenants.consumeQuota.mockResolvedValue(limit);
	const res = await handler(request({ events: [event()] }));
	expect(res.statusCode).toBe(429);
	expect(res.headers).toMatchObject({ "x-tracewise-limit": limit, "retry-after": retry });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/tenants.spec.ts test/ingest.spec.ts`
Expected: FAIL. `counterIds` isn't exported, and ingest returns a 429 without `x-tracewise-limit`.

- [ ] **Step 3: Implement the changes**
  - **`tenants.ts`:** keep the 60 s cache and wrap both reads in it.
    - New-shape rows: read `getProfile(row.org_id)`, require `row.status === "active"` and `profile.status === "active"`, and build `Tenant`.
    - Old-shape rows (`!row.org_id`): build `Tenant` from the row's own fields with `limits: legacyLimits(row.events_per_minute)`.
    - `consumeQuota` runs `consumeCounter(minute)` first, then `consumeCounter(day)`, using the existing `ADD used … ConditionExpression` pattern. The minute counter's TTL is unchanged, and the day counter's TTL is 2 days.
    - Update the comment on the cache to say a revocation or suspension takes up to a minute to apply.
  - **`ingest/handler.ts`:**
    - On `"minute"`, return `429 { error: "events-per-minute quota exceeded" }` with `retry-after: 60` and `x-tracewise-limit: minute`.
    - On `"day"`, return `429 { error: "daily event cap reached" }` with `retry-after: String(secondsUntilUtcMidnight())` and `x-tracewise-limit: day`.
    - After a successful authentication, call `if (tenant.key_id) touchKey(tenant.org_id, tenant.key_id)`. Mock `../services/shared/accounts` in `ingest.spec.ts` so `touchKey` is a `vi.fn()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/tenants.spec.ts test/ingest.spec.ts && pnpm typecheck`
Expected: PASS. `pnpm typecheck` will flag `tenant.events_per_minute` in `scripts/create-tenant.ts` and `services/evals/handlers.ts`. Leave both: Tasks 8 and 14 rewrite them. Allow those errors only for now, and note them in the commit message.

- [ ] **Step 5: Commit**

```bash
git add services/shared/tenants.ts services/ingest/handler.ts test/tenants.spec.ts test/ingest.spec.ts
git commit -m "Resolve tenants through the key index and org profile, and add a daily event cap"
```

---

### Task 3: `resolveTenant`, the JWT data routes and the analytics cap

**Files:**
- Create: `services/shared/auth.ts`
- Modify: `services/query/handler.ts`, `services/analytics/handler.ts`, `services/evals/api.ts`
- Test: `test/auth.spec.ts` (new), `test/analytics.spec.ts` (add cases)

**Interfaces:**
- Consumes: `tenantForKey`, `consumeCounter`, `counterIds` (Task 2); `getMember`, `getProfile`, `touchKey` (Task 1).
- Produces:
  - `interface Claims { sub: string; email: string; email_verified: boolean }`
  - `jwtClaims(event: APIGatewayProxyEventV2): Claims | null`. It reads `requestContext.authorizer.jwt.claims` and accepts `email_verified` as `true` or `"true"`. Email goes through `normalizeEmail`.
  - `resolveTenant(event): Promise<Tenant | null>`
    - **JWT path:** `pathParameters.orgId` + `getMember` + an active `getProfile`. Returns `scope: "read"`.
    - **Key path:** `bearerToken` → `tenantForKey`, then `touchKey`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/auth.spec.ts: mock ../services/shared/accounts and ../services/shared/tenants
const jwtEvent = (claims: object, orgId = "o1") => ({ headers: {}, pathParameters: { orgId }, requestContext: { authorizer: { jwt: { claims } } } }) as never;
it("reads string booleans from HTTP API claims", () => {
	expect(jwtClaims(jwtEvent({ sub: "u", email: "A@X.io", email_verified: "true" }))).toEqual({ sub: "u", email: "a@x.io", email_verified: true });
});
it("resolves a member's org from the path", async () => {
	accounts.getMember.mockResolvedValue({ role: "member" });
	accounts.getProfile.mockResolvedValue({ org_id: "o1", name: "Acme", status: "active", limits: FREE_LIMITS, rubric: null, evals_enabled: true });
	expect(await resolveTenant(jwtEvent({ sub: "u", email: "a@x.io", email_verified: "true" }))).toMatchObject({ tenant_id: "o1", scope: "read" });
});
it("returns null for a non-member or an inactive org", async () => {
	accounts.getMember.mockResolvedValueOnce(null);
	expect(await resolveTenant(jwtEvent({ sub: "u" }))).toBeNull();
	accounts.getMember.mockResolvedValueOnce({ role: "owner" });
	accounts.getProfile.mockResolvedValueOnce({ status: "deleting" });
	expect(await resolveTenant(jwtEvent({ sub: "u" }))).toBeNull();
});
it("falls back to the API key when there are no claims", async () => {
	tenants.tenantForKey.mockResolvedValue({ tenant_id: "t", org_id: "t", key_id: "k" });
	await resolveTenant({ headers: { authorization: `Bearer tw_${"a".repeat(43)}` }, requestContext: {} } as never);
	expect(accounts.touchKey).toHaveBeenCalledWith("t", "k");
});
```

```ts
// test/analytics.spec.ts: new cases; mock resolveTenant and consumeCounter
it("refuses once the org's daily analytics cap is used", async () => {
	tenants.consumeCounter.mockResolvedValue(false);
	const res = await handler(keyRequest({ days: "7" }));
	expect(res.statusCode).toBe(429);
	expect(res.headers).toMatchObject({ "x-tracewise-limit": "analytics" });
	expect(athenaSend).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/auth.spec.ts test/analytics.spec.ts`
Expected: FAIL, "Failed to resolve import ../services/shared/auth".

- [ ] **Step 3: Implement**
  - Implement `auth.ts`.
  - In the three handlers, replace the `bearerToken` + `tenantForKey` pair with `const tenant = await resolveTenant(event)`. The 401 body stays `{ error: "invalid API key" }` on the key path and becomes `404 { error: "not found" }` when `jwtClaims(event)` is set.
  - In analytics, before running queries, call `consumeCounter(counterIds.athena(org, now), 1, tenant.limits.analytics_queries_per_day, <now + 2 days>)`. When it returns false, respond `429 { error: "daily analytics query cap reached" }` with `x-tracewise-limit: analytics` and `retry-after` set to the seconds until midnight.
  - `/v1/me` stays on the key path only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/auth.spec.ts test/analytics.spec.ts test/ingest.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/shared/auth.ts services/query/handler.ts services/analytics/handler.ts services/evals/api.ts test/auth.spec.ts test/analytics.spec.ts
git commit -m "Let the query, analytics and evals APIs authenticate with a console session, and cap analytics per org"
```

---

### Task 4: Console route keys

**Files:**
- Create: `services/console/route-keys.ts`
- Test: `test/console-routes.spec.ts`

**Interfaces:**
- Produces:
  - `CONSOLE_ROUTES: readonly string[]`, exactly:
    ```
    GET /v1/orgs, POST /v1/orgs, GET /v1/orgs/{orgId}, PATCH /v1/orgs/{orgId}, DELETE /v1/orgs/{orgId},
    GET /v1/orgs/{orgId}/keys, POST /v1/orgs/{orgId}/keys, DELETE /v1/orgs/{orgId}/keys/{keyId},
    GET /v1/orgs/{orgId}/members, PATCH /v1/orgs/{orgId}/members/{sub}, DELETE /v1/orgs/{orgId}/members/{sub},
    GET /v1/orgs/{orgId}/invites, POST /v1/orgs/{orgId}/invites, DELETE /v1/orgs/{orgId}/invites/{inviteId},
    POST /v1/invites/accept, GET /v1/orgs/{orgId}/usage
    ```
  - `JWT_DATA_ROUTES = { query: "GET /v1/orgs/{orgId}/traces", summary: "GET /v1/orgs/{orgId}/analytics/summary", evalsApi: "GET /v1/orgs/{orgId}/evals" } as const`
  - `splitRouteKey(key: string): { method: string; path: string }`

- [ ] **Step 1: Write the failing test**

```ts
it("lists 16 console routes, all under /v1/orgs or /v1/invites, with no duplicates", () => {
	expect(CONSOLE_ROUTES).toHaveLength(16);
	expect(new Set(CONSOLE_ROUTES).size).toBe(16);
	for (const r of CONSOLE_ROUTES) expect(splitRouteKey(r).path).toMatch(/^\/v1\/(orgs|invites)/);
});
it("splits a route key", () => expect(splitRouteKey("DELETE /v1/orgs/{orgId}")).toEqual({ method: "DELETE", path: "/v1/orgs/{orgId}" }));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/console-routes.spec.ts`
Expected: FAIL, import not found.

- [ ] **Step 3: Implement `route-keys.ts`**

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run test/console-routes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (fold into Task 5's commit if you do them together)

```bash
git add services/console/route-keys.ts test/console-routes.spec.ts
git commit -m "Define the console API's routes in one place"
```

---

### Task 5: Console store, covering every Accounts write

**Files:**
- Create: `services/console/store.ts`
- Test: `test/console-store.spec.ts`

**Interfaces:**
- Consumes: Task 1's types, `k`, `FREE_LIMITS`, `normalizeEmail`, `INVITE_TTL_DAYS`; `newApiKey`, `hashApiKey` (keys.ts); `ddb` (ddb.ts).
- Env: `ACCOUNTS_TABLE`, `TENANTS_TABLE` (the key index), `CONSOLE_ORIGIN`.
- Produces:
  - `createOrg(input: { name: string; owner?: { sub: string; email: string }; plan?: "free" | "custom"; limits?: Limits }): Promise<{ org: OrgProfile; key: { record: KeyRecord; secret: string } }>`
  - `updateProfile(orgId, patch: { name?: string; rubric?: string | null; evals_enabled?: boolean; limits?: Limits; plan?: "free" | "custom" }): Promise<OrgProfile>`
  - `startDeletion(orgId): Promise<boolean>`
  - `listKeys(orgId): Promise<KeyRecord[]>`
  - `createKey(orgId, input: { name: string; scope: "read" | "write"; created_by: string }): Promise<{ record: KeyRecord; secret: string }>`
  - `revokeKey(orgId, keyId): Promise<boolean>`
  - `listMembers(orgId): Promise<Member[]>`
  - `setRole(orgId, sub, role): Promise<"ok" | "last_owner" | "not_found">`
  - `removeMember(orgId, sub): Promise<"ok" | "last_owner" | "not_found">`
  - `createInvite(orgId, input: { email: string; role: Role; created_by: string }): Promise<{ invite: Invite; token: string; link: string }>`
  - `listInvites(orgId, now = Date.now()): Promise<Invite[]>`
  - `revokeInvite(orgId, inviteId): Promise<boolean>`
  - `acceptInvite(token: string, claims: { sub: string; email: string; email_verified: boolean }, now = Date.now()): Promise<{ org_id: string } | null>`
  - `countOwnedOrgs(sub): Promise<number>`
  - `findOrgByName(name): Promise<OrgProfile | null>`, used by scripts

- [ ] **Step 1: Write the failing tests.** Mock `../services/shared/ddb` with `{ ddb: { send: vi.fn() } }` and assert on the commands sent.

```ts
it("creates an org, its owner and a first key in one transaction", async () => {
	const { org, key } = await createOrg({ name: "Acme", owner: { sub: "u1", email: "a@x.io" } });
	const tx = sent(TransactWriteCommand)[0]!.input.TransactItems!;
	expect(tx.map((i) => Object.keys(i)[0])).toEqual(["Put", "Put", "Put", "Put", "Put"]); // PROFILE, MEMBER, USER, KEY, key index
	expect(tx[0]!.Put!.Item).toMatchObject({ pk: `ORG#${org.org_id}`, sk: "PROFILE", plan: "free", limits: FREE_LIMITS, owner_count: 1, evals_enabled: true, rubric: null });
	expect(tx[2]!.Put!.Item).toMatchObject({ pk: "USER#u1", sk: `ORG#${org.org_id}`, role: "owner", org_name: "Acme" });
	expect(key.secret).toMatch(/^tw_[A-Za-z0-9_-]{43}$/);
	expect(JSON.stringify(tx)).not.toContain(key.secret); // only the hash is stored
	expect(key.record.prefix).toBe(key.secret.slice(0, 9));
	expect(key.record.name).toBe("Default");
});
it("an operator-created org has no owner and owner_count 0", async () => { /* createOrg({ name }) → 3 Puts (PROFILE, KEY, index), owner_count 0 */ });
it("renaming updates org_name on every member's USER item", async () => { /* listMembers returns 2 → 1 profile Update + 2 USER Updates */ });
it("demoting an owner is conditional on another owner existing", async () => {
	ddb.send.mockResolvedValueOnce({ Item: { role: "owner" } }) // getMember
		.mockRejectedValueOnce(new TransactionCanceledException({ message: "x", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }));
	expect(await setRole("o1", "u1", "member")).toBe("last_owner");
	const tx = sent(TransactWriteCommand)[0]!.input.TransactItems!;
	expect(tx.find((i) => i.Update?.Key?.sk === "PROFILE")!.Update!.ConditionExpression).toContain("owner_count > :one");
});
it("removing a plain member doesn't touch owner_count", async () => { /* no PROFILE update in the transaction */ });
it("stores invite emails normalised and only the token's hash", async () => {
	const { invite, token, link } = await createInvite("o1", { email: "  Alice@Example.com", role: "member", created_by: "u1" });
	expect(invite.email).toBe("alice@example.com");
	expect(link).toBe(`${process.env.CONSOLE_ORIGIN}/console/index.html#/invite/${token}`);
	expect(JSON.stringify(sent(TransactWriteCommand)[0]!.input)).not.toContain(token);
	expect(invite.expires_at).toBe(Math.floor(Date.now() / 1000) + 7 * 86_400); // use fake timers
});
it.each([
	["wrong email", { email: "bob@x.io", email_verified: true }],
	["unverified email", { email: "alice@example.com", email_verified: false }],
])("refuses to accept an invite with a %s", async (_n, claims) => { /* findInvite returns a valid invite → null, no TransactWrite */ });
it("refuses an expired invite even before TTL removes it", async () => { /* expires_at in the past → null */ });
it("accepting adds the member and deletes the invite atomically, and a reuse gets null", async () => {
	// first call: TransactWrite contains Put MEMBER (attribute_not_exists), Put USER, Delete INVITE#hash (attribute_exists), Delete ORG#/INVITE#id; owner role adds owner_count +1
	// second call: TransactionCanceledException(ConditionalCheckFailed) → null
});
it("startDeletion only moves an active org to deleting", async () => { /* Update with ConditionExpression "#s = :active"; ConditionalCheckFailed → false */ });
it("revoking a key marks both the KEY item and the key-index row", async () => { /* TransactWrite with 2 Updates: revoked_at, status revoked */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/console-store.spec.ts`
Expected: FAIL, import not found.

- [ ] **Step 3: Implement `store.ts`**
  - **IDs and tokens:** `crypto.randomUUID()` for org, key and invite IDs. Invite tokens are `randomBytes(32).toString("base64url")`, and `token_hash` is `hashApiKey(token)`.
  - **Writes that must happen together use `TransactWriteCommand`.** That covers create org, create key, revoke key, role change, remove member, invite create, revoke and accept.
  - **Mapping `TransactionCanceledException`:** when any reason is `ConditionalCheckFailed`, the domain result is `"last_owner"` or `null`, whichever the operation returns.
  - **`listInvites`** drops items whose `expires_at` has passed.
  - **`countOwnedOrgs`** counts the `USER#sub` items with `role = owner`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/console-store.spec.ts && pnpm typecheck`
Expected: PASS. Only the type errors from Task 2 remain.

- [ ] **Step 5: Commit**

```bash
git add services/console/store.ts test/console-store.spec.ts
git commit -m "Add the console store: orgs, keys, members and invites with transactional rules"
```

---

### Task 6: Console handler and routes

**Files:**
- Create: `services/console/handler.ts`, `services/console/routes/orgs.ts`, `routes/keys.ts`, `routes/team.ts`, `routes/usage.ts`
- Test: `test/console.spec.ts`

**Interfaces:**
- Consumes: Task 4's `CONSOLE_ROUTES`; every Task 5 store function; `getMember`, `getProfile`, `listUserOrgs` and the constants from Task 1; `jwtClaims` (Task 3); `consumeCounter`, `readCounter`, `counterIds` (Task 2); `DEFAULT_RUBRIC` (`services/evals/judge-prompt.ts`).
- Env: `DELETION_QUEUE_URL`.
- Produces:
  - `handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2>`
  - In `handler.ts`: `type Access = "user" | "member" | "owner" | "self-or-owner"`, `interface Ctx { claims: Claims; params: Record<string, string>; body: unknown; member?: Member; profile?: OrgProfile }`, `interface Route { access: Access; verified?: boolean; run(ctx: Ctx): Promise<APIGatewayProxyStructuredResultV2> }`, `type RouteTable = Record<string, Route>`
  - Each `routes/*.ts` exports a `RouteTable`. The handler merges them and asserts at module load that the merged keys equal `CONSOLE_ROUTES`.
  - The deletion message, sent to SQS by `DELETE /v1/orgs/{orgId}`: `{ org_id: string; phase: "dynamo" }`. Task 7 defines the full `DeletionMessage`.

How a request is handled:
1. Look up `routes[event.routeKey]`. If there isn't one, return 404.
2. `jwtClaims`. If there are none, return 401.
3. For `member`, `owner` and `self-or-owner`, load the member and profile. If either is missing, or the profile isn't `active`, return 404.
4. `owner` requires `member.role === "owner"`, otherwise 403. `self-or-owner` allows `params.sub === claims.sub` or an owner.
5. `verified: true` requires `claims.email_verified`, otherwise `403 { error: "verify your email first" }`.
6. Parse the body as JSON and validate it with each route's zod schema. On failure, return `400 { error, issues }`.

Route specifics, with the values from spec §4–5:
- **`POST /v1/orgs`** (`user`, `verified`):
  1. If `countOwnedOrgs` ≥ 3 → `429 { error: "sign-ups are paused, try again tomorrow" }`.
  2. `consumeCounter(counterIds.globalOrgs(now), 1, 100, now + 2 days)`. If it returns false → the same 429, plus `PutMetricData` with namespace `Tracewise/Limits`, metric `GlobalCapHit`, dimension `Cap=orgs`, value 1.
  3. `createOrg`, then return `201 { org, key: { ...record, secret } }`.
- **`GET /v1/orgs/{orgId}`** returns `{ ...profile, role, default_rubric: DEFAULT_RUBRIC }`.
- **`PATCH`** (owner) uses zod: `name` 1–100, `rubric` ≤ 4,000 or null, `evals_enabled` boolean, at least one field.
- **`DELETE /v1/orgs/{orgId}`** (owner):
  - `confirm_name` must equal `profile.name`, otherwise 400.
  - `startDeletion`, then `SendMessageCommand` with `{ org_id, phase: "dynamo" }`, then 202.
- **Keys** (member): `POST` body `{ name: 1–100, scope: "read" | "write" }`. Return `409 { error: "limit reached", limit: "max_keys" }` when `listKeys().length >= limits.max_keys`.
- **Members:**
  - `PATCH` (owner) body `{ role }`. `"last_owner"` → `409 { error: "an organisation needs at least one owner" }`, and `"not_found"` → 404.
  - `DELETE` (`self-or-owner`) maps results the same way.
- **Invites** (owner):
  - `POST` body `{ email: z.email(), role }`.
  - Returns 409 `max_pending_invites` when the pending count ≥ the limit, and 409 `max_members` when members + pending ≥ `max_members`.
  - Returns `201 { invite_id, link, expires_at }`.
- **`POST /v1/invites/accept`** (`user`) with `{ token }`: `acceptInvite`, then `null` → `404 { error: "not found" }`.
- **`GET /v1/orgs/{orgId}/usage`** (member) reads counters for minute, day, athena and evals, using yesterday's day for evals, and returns:

```
{ limits, used: { events_this_minute, events_today, analytics_queries_today, eval_samples_last_night, keys, members, pending_invites } }
```

- [ ] **Step 1: Write the failing tests.** Mock `../services/console/store`, `../services/shared/accounts` and `../services/shared/tenants`, and spy on `SQSClient.prototype.send` and `CloudWatchClient.prototype.send`.

```ts
const call = (routeKey: string, { claims = owner, params = {}, body }: Partial<Req> = {}) =>
	handler({ routeKey, pathParameters: params, body: body && JSON.stringify(body), headers: {}, requestContext: { authorizer: { jwt: { claims } } } } as never);
const orgRoutes = CONSOLE_ROUTES.filter((r) => r.includes("{orgId}"));
it.each(orgRoutes)("%s returns 404 to a non-member", async (r) => {
	accounts.getMember.mockResolvedValue(null);
	expect((await call(r, { params: { orgId: "o1", keyId: "k", sub: "s", inviteId: "i" } })).statusCode).toBe(404);
});
it.each(["PATCH /v1/orgs/{orgId}", "DELETE /v1/orgs/{orgId}", "PATCH /v1/orgs/{orgId}/members/{sub}", "GET /v1/orgs/{orgId}/invites", "POST /v1/orgs/{orgId}/invites", "DELETE /v1/orgs/{orgId}/invites/{inviteId}"])("%s returns 403 to a plain member", async (r) => { /* member role → 403 { error: "owner only" } */ });
it("hides an org that is being deleted", async () => { /* profile.status "deleting" → GET /v1/orgs/{orgId} 404 */ });
it("lets a member remove themselves but not someone else", async () => { /* DELETE members/{sub} with sub === claims.sub → store.removeMember called; other sub → 403 */ });
it("requires a verified email to create an org", async () => { /* email_verified "false" → 403 "verify your email first" */ });
it("caps orgs per owner and per day, and reports the global cap", async () => {
	store.countOwnedOrgs.mockResolvedValueOnce(3);
	expect((await call("POST /v1/orgs", { body: { name: "A" } })).statusCode).toBe(429);
	store.countOwnedOrgs.mockResolvedValueOnce(0); tenants.consumeCounter.mockResolvedValueOnce(false);
	expect((await call("POST /v1/orgs", { body: { name: "A" } })).statusCode).toBe(429);
	expect(metricInput()).toMatchObject({ Namespace: "Tracewise/Limits", MetricData: [{ MetricName: "GlobalCapHit", Dimensions: [{ Name: "Cap", Value: "orgs" }] }] });
});
it("returns the key secret only when it's created", async () => { /* POST keys → body.key.secret present; GET keys → no "secret" and no "key_hash" anywhere in JSON */ });
it("refuses a fifth member via invites when members + pending reach the limit", async () => { /* 4 members + 1 pending, max_members 5 → 409 limit max_members */ });
it("validates rubric length and name length", async () => { /* rubric 4001 chars → 400; name "" → 400; name 100 chars → 200 */ });
it("deletes only with the exact org name, then queues the deleter", async () => { /* wrong name → 400, no SQS; right → 202 and SQS body { org_id: "o1", phase: "dynamo" } */ });
it("maps last-owner refusals to 409", async () => { /* store.setRole → "last_owner" → 409 */ });
it("accepts an invite with the invitee's claims, case-insensitively", async () => {
	await call("POST /v1/invites/accept", { claims: { sub: "u2", email: "Alice@Example.com", email_verified: "true" }, body: { token: "t" } });
	expect(store.acceptInvite).toHaveBeenCalledWith("t", { sub: "u2", email: "alice@example.com", email_verified: true });
});
it("reports usage against limits", async () => { /* readCounter values → used.* fields and limits echoed */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/console.spec.ts`
Expected: FAIL, import not found.

- [ ] **Step 3: Implement the handler and route modules** as specified. Log with `log()` from `services/shared/http.ts` using `{ route, org_id, sub }`, and never log bodies, secrets or tokens.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/console.spec.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/console test/console.spec.ts
git commit -m "Add the console API: orgs, keys, team, invites and usage behind membership checks"
```

---

### Task 7: Org deleter

**Files:**
- Create: `services/deleter/handler.ts`
- Test: `test/deleter.spec.ts`

**Interfaces:**
- Consumes: `partitionsForDay`, `HOT_RETENTION_DAYS` (keys.ts); `k` and the types from Task 1; `ddb` (ddb.ts, mocked in tests like Task 5).
- Env: `TRACES_TABLE`, `EVALS_TABLE`, `ACCOUNTS_TABLE`, `TENANTS_TABLE`, `LAKE_BUCKET`, `DELETION_QUEUE_URL`.
- Produces:
  - `type Phase = "dynamo" | "evals" | "s3" | "sweep" | "accounts"`
  - `interface DeletionMessage { org_id: string; phase: Phase; cursor?: { day?: number; shard?: number; lastKey?: Record<string, unknown>; token?: string } }`
  - `runPhase(msg: DeletionMessage, now = Date.now()): Promise<DeletionMessage | null>`, which returns the next message or null when done
  - `handler(event: SQSEvent): Promise<SQSBatchResponse>`

Phase order: `dynamo` (traces, day offsets 0…`HOT_RETENTION_DAYS + 2`, every shard) → `evals` → `s3` → `sweep` → `accounts`.
- Each invocation does at most **20 BatchWrite calls of 25 deletes**, or **3 `DeleteObjects` calls of 1,000 keys**, then returns a cursor for the same phase.
- Moving from `s3` to `sweep` is sent with `DelaySeconds: 900`.
- `accounts` does three things:
  1. Queries `ORG#id`.
  2. Deletes every non-PROFILE item, the matching `USER#sub/ORG#id` items, and the key-index rows (found through each `KEY` item's `key_hash`).
  3. Updates PROFILE to `status: deleted`, `deleted_at: <iso>` and `REMOVE rubric`.
- BatchWrite `UnprocessedItems` are retried with backoff, like the processor does. Anything still left over throws, so SQS retries the message.

- [ ] **Step 1: Write the failing tests**

```ts
it("deletes trace partitions shard by shard and returns a cursor when the budget runs out", async () => {
	ddb.send.mockImplementation(async (c) => (c instanceof QueryCommand ? { Items: Array.from({ length: 100 }, (_, i) => ({ pk: "p", sk: String(i) })), LastEvaluatedKey: { pk: "p" } } : { UnprocessedItems: {} }));
	const next = await runPhase({ org_id: "o1", phase: "dynamo" });
	expect(next).toMatchObject({ org_id: "o1", phase: "dynamo", cursor: { day: 0, shard: 0, lastKey: { pk: "p" } } });
	expect(sent(BatchWriteCommand).length).toBeLessThanOrEqual(20);
});
it("covers HOT_RETENTION_DAYS + 2 days of partitions before moving on", async () => { /* empty queries → final call returns { phase: "evals" }; queried pks include `o1#<today - 32d>#9` */ });
it("deletes only the org's S3 prefix", async () => { /* ListObjectsV2 input Prefix "traces/tenant_id=o1/" */ });
it("schedules the sweep 15 minutes after the first S3 pass", async () => { /* handler: runPhase(s3) returns sweep → SQS SendMessage DelaySeconds 900 */ });
it("leaves a tombstone after removing members, keys, invites and key-index rows", async () => {
	// ORG#o1 items: PROFILE, MEMBER#u1, KEY#k1 (key_hash h1), INVITE#i1
	// expect deletes for MEMBER#u1, KEY#k1, INVITE#i1, USER#u1/ORG#o1, key index h1; PROFILE Update status deleted + REMOVE rubric; returns null
});
it("reports a failed message so SQS retries it", async () => { /* runPhase throws → batchItemFailures [{ itemIdentifier }] */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/deleter.spec.ts`
Expected: FAIL, import not found.

- [ ] **Step 3: Implement `deleter/handler.ts`.** Install the S3 client first:

```bash
pnpm add @aws-sdk/client-s3@3.1155.0
```

If pnpm refuses it, add it to `minimumReleaseAgeExclude` first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/deleter.spec.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/deleter test/deleter.spec.ts package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "Add the org deleter: traces, eval runs, lake prefix with a delayed sweep, then accounts"
```

---

### Task 8: Evals read org profiles and share the judge budget

**Files:**
- Modify: `services/evals/handlers.ts`
- Test: `test/evals-handlers.spec.ts` (new)

**Interfaces:**
- Consumes: `listActiveProfiles`, `GLOBAL_JUDGE_CALLS_PER_NIGHT` (Task 1); `counterIds.evals` (Task 2); `ddb`.
- Env added: `ACCOUNTS_TABLE` (list), `QUOTAS_TABLE` (sample).
- Produces: `TenantRef` gains `sample_budget: number` and `sample_limit: number`. The record step stores `sample_budget` and `sample_shortfall: sample_limit - sample_budget` on the run item.

`listTenants`:
1. Takes the active profiles with `evals_enabled`.
2. Adds old-shape key rows from `TENANTS_TABLE` that have no `org_id` and no profile, de-duplicated by `tenant_id` and using `legacyLimits` (the fallback, removed in Task 16).
3. Computes `share = Math.floor(2000 / n)` and `sample_budget = Math.min(limits.eval_samples_per_night, share)`.
4. If any org's budget is below its limit, publishes `GlobalCapHit` with `Cap=judge`.

`sample` takes `Math.min(tenant.sample_budget, SAMPLE_SIZE)` keys and writes `PutCommand { window: counterIds.evals(org, day), used: n, expires_at: now + 3 days }` to `QUOTAS_TABLE`.

- [ ] **Step 1: Write the failing tests**

```ts
it("evaluates active orgs with evals on, with their rubric", async () => { /* profiles a (on, rubric "r"), b (off) → tenants [{ tenant_id: "a", rubric: "r", sample_budget: 20, sample_limit: 20 }] */ });
it("still evaluates tenants that haven't been migrated", async () => { /* key index has { tenant_id: "t", name, status: "active", events_per_minute: 6000 } without org_id → included once, rubric null */ });
it("splits 2,000 judge calls across orgs and reports the cap", async () => {
	// 150 profiles with eval_samples_per_night 20 → share 13 → every sample_budget 13, sample_limit 20
	expect(metric()).toMatchObject({ Namespace: "Tracewise/Limits", MetricData: [{ MetricName: "GlobalCapHit", Dimensions: [{ Name: "Cap", Value: "judge" }] }] });
});
it("samples no more than the budget and records the count", async () => { /* 50 candidate keys, sample_budget 5 → 5 keys; Put window "a#evals#2026-10-21" used 5 */ });
it("records the shortfall on the run", async () => { /* record with sample_budget 13, sample_limit 20 → Put item has sample_shortfall 7 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/evals-handlers.spec.ts`
Expected: FAIL. `sample_budget` is undefined.

- [ ] **Step 3: Implement the changes** in `handlers.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/evals-handlers.spec.ts test/evals.spec.ts && pnpm typecheck`
Expected: PASS. The only type error left is in `scripts/create-tenant.ts`, which Task 14 rewrites.

- [ ] **Step 5: Commit**

```bash
git add services/evals/handlers.ts test/evals-handlers.spec.ts
git commit -m "Run nightly evals from org profiles and cap judge calls across all orgs"
```

---

### Task 9: Infrastructure: Accounts table, Cognito, console and deleter

**Files:**
- Create: `infra/lib/accounts.ts`
- Modify: `infra/lib/tracewise-stack.ts`, `infra/lib/evals.ts`, `infra/bin/tracewise.ts`
- Test: `infra/test/stack.spec.ts`

**Interfaces:**
- Consumes: `CONSOLE_ROUTES` and `JWT_DATA_ROUTES` (Task 4); handler entry points `console/handler.ts` and `deleter/handler.ts`.
- Produces:
  - `TracewiseStackProps` gains `authDomainPrefix?: string` (default `` `tracewise-${Aws.ACCOUNT_ID}` ``) and `smokeClient?: boolean`. `bin/tracewise.ts` sets `smokeClient: app.node.tryGetContext("smokeClient") === "true"`.
  - Stack Storage section: a new `Accounts` `TableV2` (`pk`/`sk`, on-demand, TTL `expires_at`, AWS-managed key, `RemovalPolicy.DESTROY`).
  - `class Accounts extends Construct` with:
    - props `{ fn; accounts: ITableV2; keyIndex: ITableV2; quotas: ITableV2; traces: ITableV2; evalRuns: ITableV2; lake: IBucket; alerts: ITopic; authDomainPrefix: string; smokeClient: boolean }`
    - fields `userPool`, `authDomainUrl: string` (`https://${prefix}.auth.${region}.amazoncognito.com`, built from the prefix string so CloudFront can use it without a cycle), `consoleFn`, `deleterFn`, `deletionQueue`
    - method `connect(api: HttpApi, origin: string, data: { query: IFunction; summary: IFunction; evalsApi: IFunction }): { clientId: string; smokeClientId?: string }`
  - `Evals` exposes `listFn` and `sampleFn`, so the stack can grant Accounts read and Quotas write and set `ACCOUNTS_TABLE`/`QUOTAS_TABLE`.
  - New `CfnOutput`s: `UserPoolId`, `ConsoleClientId`, `SmokeClientId` (when enabled), `AccountsTable`, `DeletionQueue`.

Cognito settings, from spec §2:
- **User pool:** self sign-up, sign in with email, email auto-verified, `Mfa.OPTIONAL` with TOTP only, `FeaturePlan.ESSENTIALS`, `AccountRecovery.EMAIL_ONLY`, password minimum length 12, `RemovalPolicy.DESTROY`.
- **Domain:** `managedLoginVersion: NEWER_MANAGED_LOGIN`, plus `CfnManagedLoginBranding { useCognitoProvidedValues: true }`.
- **Console client:** no secret, authorization-code grant only, scopes `openid email profile`, callback and logout URL `${origin}/console/index.html`, refresh token valid for 30 days, token revocation on, `preventUserExistenceErrors`, and the property override `RefreshTokenRotation: { Feature: "ENABLED", RetryGracePeriodSeconds: 10 }`.
- **Smoke client:** only when `smokeClient` is set, with `authFlows: { adminUserPassword: true }` and no OAuth.
- **Authorizer:** `HttpJwtAuthorizer` with issuer `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`, `jwtAudience` = the client IDs, and identity source `$request.header.Authorization`.
- **Routes:** add each `CONSOLE_ROUTES` entry with one shared `HttpLambdaIntegration` to `consoleFn`, and each `JWT_DATA_ROUTES` entry to its function, all with the authorizer.

IAM, from spec §8:
- **console:** Accounts read/write, key index read/write, Quotas read/write, `deletionQueue.grantSendMessages`, and `cloudwatch:PutMetricData` limited to the `Tracewise/Limits` namespace.
- **deleter:** traces read/write, eval runs read/write, Accounts read/write, key index read/write, `s3:ListBucket` on the lake with condition `s3:prefix` like `traces/tenant_id=*`, `s3:DeleteObject` on `traces/*`, and send on its own queue. It's an SQS event source with batch size 1 and `reportBatchItemFailures`.
- **ingest, query, summary, evalsApi:** Accounts read. Ingest also gets `dynamodb:UpdateItem` on Accounts, for `touchKey`.
- **The `listTenants` function:** Accounts read and the `Tracewise/Limits` metric.
- **The `sample` function:** Quotas write.

Queues and alarms:
- **Deletion queue:** visibility timeout 6× the deleter's 60 s timeout, a dead-letter queue after 5 receives, SQS-managed encryption and `enforceSSL`.
- **Alarm `DeletionDeadLetters`**, like `DeadLetters`.
- **Alarms `GlobalOrgCap` and `GlobalJudgeCap`:** metric `Tracewise/Limits GlobalCapHit` with `Cap=orgs|judge`, sum over 5 minutes, threshold ≥ 1. All alarm through the existing `alarms` topic.

- [ ] **Step 1: Write the failing assertions** in `infra/test/stack.spec.ts`:
  - Update counts: tables 4 → **5**, functions 9 → **11**, alarms 3 → **6**.
  - Add:

```ts
it("protects every console and session route with the Cognito JWT authorizer, and no key route", () => {
	const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties);
	const jwt = [...CONSOLE_ROUTES, ...Object.values(JWT_DATA_ROUTES)];
	for (const key of jwt) expect(routes.find((r) => r.RouteKey === key)).toMatchObject({ AuthorizationType: "JWT" });
	for (const key of ["POST /v1/traces", "GET /v1/traces", "GET /v1/analytics/summary", "GET /v1/evals", "GET /v1/me"])
		expect(routes.find((r) => r.RouteKey === key)?.AuthorizationType ?? "NONE").toBe("NONE");
	template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"] });
});
it("signs users in with verified email, optional TOTP and no SMS", () => {
	template.hasResourceProperties("AWS::Cognito::UserPool", { AutoVerifiedAttributes: ["email"], UsernameAttributes: ["email"], MfaConfiguration: "OPTIONAL", EnabledMfas: ["SOFTWARE_TOKEN_MFA"] });
	template.hasResourceProperties("AWS::Cognito::UserPoolClient", { GenerateSecret: false, AllowedOAuthFlows: ["code"], RefreshTokenRotation: { Feature: "ENABLED" } });
});
it("only creates the password-auth smoke client when asked", () => { /* default template: no client with ALLOW_ADMIN_USER_PASSWORD_AUTH; synth with smokeClient: true → one */ });
it("keeps the console function away from traces, the lake and eval runs", () => {
	const doc = JSON.stringify(policiesFor(/ConsoleFnServiceRole/));
	expect(doc).not.toMatch(/Traces|Lake|EvalsRuns/);
});
it("gives the deleter delete rights on the lake's traces prefix, listing only tenant prefixes", () => {
	const doc = JSON.stringify(policiesFor(/DeleterFnServiceRole/));
	expect(doc).toMatch(/s3:DeleteObject/);
	expect(doc).toContain("traces/tenant_id=*");
	for (const re of [/ConsoleFnServiceRole/, /QueryServiceRole/, /IngestServiceRole/]) expect(JSON.stringify(policiesFor(re))).not.toMatch(/s3:DeleteObject/);
});
```

  - Firehose's delivery role already has delete on `traces/*` through `grantReadWrite`, which is how it works today. So the test pins the deleter's grant and checks that the console, query and ingest roles have none, rather than claiming the deleter is the only role with delete.
  - `policiesFor(re)` is a small helper at the top of the file that factors out the filter already used in the ingest and summary tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run infra/test/stack.spec.ts`
Expected: FAIL. The table count is 4, and there are no JWT routes.

- [ ] **Step 3: Implement `accounts.ts` and the stack wiring.** In the stack, the order is:
  1. tables
  2. functions
  3. `const accounts = new Accounts(...)`
  4. API
  5. `const dashboard = new Dashboard(this, "Dashboard", { api, authDomainUrl: accounts.authDomainUrl })`
  6. `const { clientId } = accounts.connect(api, `https://${dashboard.distribution.distributionDomainName}`, { query, summary, evalsApi })`
  7. `dashboard.deploy({ demoKey: props.dashboardKey ?? "", auth: { domain: accounts.authDomainUrl, clientId } })`

  Steps 5 and 7 need Task 10's Dashboard changes. Implement the `Dashboard` prop and the `deploy()` signature here as a pass-through: move the existing `BucketDeployment` into `deploy()`. Task 10 adds the behaviours and CSP.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run infra/test/stack.spec.ts && pnpm synth`
Expected: PASS, and synth completes without errors.

- [ ] **Step 5: Commit**

```bash
git add infra
git commit -m "Deploy accounts: Cognito, the console and deleter functions, JWT routes and global-cap alarms"
```

---

### Task 10: CloudFront: uncached console API and console CSP

**Files:**
- Modify: `infra/lib/dashboard.ts`
- Test: `infra/test/stack.spec.ts`

**Interfaces:**
- Consumes: `authDomainUrl` (Task 9).
- Produces:
  - `DashboardProps = { api: HttpApi; authDomainUrl: string }`. `demoReadKey` moves to `deploy`.
  - `deploy(config: { demoKey: string; auth: { domain: string; clientId: string } }): void`, which writes `config.json` with exactly that shape.

Behaviours, in insertion order (CloudFront precedence):
1. `/v1/orgs*` and `/v1/invites/*`: API origin, `CachePolicy.CACHING_DISABLED`, `ALLOW_ALL`, `ALL_VIEWER_EXCEPT_HOST_HEADER`, `HTTPS_ONLY`.
2. `/v1/*`: unchanged.
3. `/console/*`: S3 origin, `CACHING_OPTIMIZED`, and a new `ConsoleHeaders` response-headers policy. It's identical to `SecurityHeaders` except `connect-src 'self' ${authDomainUrl}`.

- [ ] **Step 1: Write the failing assertions.** Replace the `CacheBehaviors: [ … /v1/* ]` expectation with:

```ts
it("never caches console API calls, and checks them before the cached /v1/* behaviour", () => {
	const [dist] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
	const behaviors = dist!.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string; CachePolicyId: unknown }[];
	expect(behaviors.map((b) => b.PathPattern)).toEqual(["/v1/orgs*", "/v1/invites/*", "/v1/*", "/console/*"]);
	expect(behaviors[0]!.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // managed CachingDisabled
	expect(behaviors[1]!.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
});
it("lets only the console talk to Cognito, and keeps scripts first-party", () => {
	const csps = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy")).map((p) => JSON.stringify(p.Properties));
	expect(csps).toHaveLength(2);
	expect(csps.filter((c) => c.includes("amazoncognito.com"))).toHaveLength(1);
	for (const c of csps) expect(c).toContain("script-src 'self';");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run infra/test/stack.spec.ts`
Expected: FAIL, because only `/v1/*` exists.

- [ ] **Step 3: Implement the changes** in `dashboard.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run infra/test/stack.spec.ts && pnpm synth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add infra/lib/dashboard.ts infra/test/stack.spec.ts
git commit -m "Serve the console with its own CSP and never cache console API calls"
```

---

### Task 11: Move shared dashboard code into modules

**Files:**
- Create: `dashboard/shared/dom.js`, `dashboard/shared/format.js`, `dashboard/shared/charts.js`
- Modify: `dashboard/app.js`, `dashboard/index.html` (add a "Sign up" link)
- Test: `test/dashboard-format.spec.ts`

**Interfaces:**
- Produces:
  - `shared/dom.js`: `$`, `el(tag, attrs, ...children)`, `storage`, `empty(container, text)`
  - `shared/format.js`: `fmtCalls`, `fmtCost`, `fmtMs`, `fmtPct`, `shortDay`, `sum`, `niceMax`
  - `shared/charts.js`: `columnChart`, `lineChart`, `sparkline`, `table`, `magnitude`, `tile`, `showTip`, `hideTip`
  - All are named exports with the same signatures as today's `app.js` functions (lines 5–270). `format.js` must not touch `document` or `window` at import time.

- [ ] **Step 1: Write the failing test**

```ts
import { fmtCost, fmtMs, fmtPct, niceMax } from "../dashboard/shared/format.js";
it("formats like the dashboard always has", () => {
	expect(fmtCost(0)).toBe("$0"); expect(fmtCost(0.004)).toBe("$0.0040"); expect(fmtCost(12.5)).toBe("$12.50");
	expect(fmtMs(840)).toBe("840 ms"); expect(fmtMs(1500)).toBe("1.5 s"); expect(fmtPct(0.05)).toBe("5.0%");
	expect(niceMax(87)).toBeGreaterThanOrEqual(87);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run test/dashboard-format.spec.ts`
Expected: FAIL, file not found.

- [ ] **Step 3: Move the code without changing behaviour.** `app.js` imports from `./shared/*.js`. In `index.html`, add `<a class="button" href="console/index.html">Sign up</a>` before `#key-button`, and leave everything else unchanged.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/dashboard-format.spec.ts`
Expected: PASS.

Then check the demo in the browser:
- Add a `.claude/launch.json` entry `dashboard` that runs `python3 -m http.server 4173 -d dashboard`, which needs no install. Write `dashboard/config.json` locally with `{"demoKey":""}`, and don't commit it.
- Open it with `preview_start`.
- `read_console_messages` must show no module-resolution errors, and the page must render its empty or error state as it did before the move.

- [ ] **Step 5: Commit**

```bash
git add dashboard/shared dashboard/app.js dashboard/index.html test/dashboard-format.spec.ts
git commit -m "Split the dashboard's rendering code into shared modules"
```

---

### Task 12: Console shell: auth, API client, router

**Files:**
- Create: `dashboard/console/index.html`, `console.css`, `auth.js`, `api.js`, `router.js`, `app.js`
- Test: `test/console-web.spec.ts`

**Interfaces:**
- Consumes: `config.json` `{ demoKey, auth: { domain, clientId } }` (Task 10); `shared/dom.js` (Task 11).
- Produces:
  - **`auth.js`:**
    - `challengeFor(verifier: string): Promise<string>`, base64url SHA-256
    - `pkcePair(): Promise<{ verifier: string; challenge: string }>`, where the verifier is 48 random bytes encoded as base64url (64 characters)
    - `authorizeUrl(cfg, { challenge, state, signup = false }): string`. Uses `${domain}/signup` when `signup`, otherwise `${domain}/oauth2/authorize`, with `response_type=code`, `client_id`, `redirect_uri=${location.origin}/console/index.html`, `scope=openid email profile`, `code_challenge_method=S256`, `code_challenge`, `state`.
    - `signIn(cfg, { signup })`, which stores the verifier and state in `sessionStorage` and redirects
    - `handleCallback(cfg, url: URL): Promise<boolean>`. It checks `state`, POSTs `grant_type=authorization_code` to `${domain}/oauth2/token`, keeps the ID token in memory and the refresh token in `sessionStorage`, then strips `code`/`state` with `history.replaceState`.
    - `idToken({ force = false } = {}): Promise<string | null>`, which refreshes when the token expires within 60 s or when `force`
    - `signOut(cfg)`, which clears storage and redirects to `${domain}/logout?client_id&logout_uri`
    - `decodeJwt(token): Record<string, unknown>`
  - **`api.js`:**
    - `class AuthError extends Error`
    - `createApi({ getToken, fetch = globalThis.fetch }): { get(path), post(path, body), patch(path, body), del(path, body?) }`. Paths are absolute, like `/v1/orgs/...`.
    - On 401 it calls `getToken({ force: true })` once and retries once. A second 401 throws `AuthError`.
    - Other non-2xx responses throw `Error(messageFor(status, body))`.
    - `messageFor(status: number, body: { error?: string; limit?: string }): string`:
      - 404 → "Not found, or you don't have access."
      - 409 with `limit` → "You've reached your plan's limit (<limit>)."
      - 429 → `body.error`
      - otherwise → `body.error ?? "Something went wrong (HTTP <status>)."`
  - **`router.js`:** `parseHash(hash: string): { view: "orgs-new" | "overview" | "traces" | "keys" | "team" | "usage" | "settings" | "invite"; param?: string }`. The default is `overview`, and `#/invite/<token>` gives `{ view: "invite", param: token }`.
  - **`app.js`** (shell) does the following:
    1. Loads config and handles the callback.
    2. Without a token, shows a sign-in/sign-up screen. With an invite hash, it first saves the token to `sessionStorage` (`tw_pending_invite`) so it survives the redirect.
    3. Loads `GET /v1/orgs`. With no orgs it goes to `orgs-new`. Otherwise it selects the org saved in `sessionStorage` (`tw_org`) or the first one.
    4. Renders the header (org switcher, sign out, theme toggle) and the nav.
    5. Calls `views/<view>.js` `render(root, ctx)`, where `ctx = { api, org, orgs, me: decodeJwt(idToken), navigate(hash), refreshOrgs() }`.
    6. If a view's API call returns 404 for the current org, the shell clears `tw_org` and reloads the org list, so a deleted org drops out cleanly.

- [ ] **Step 1: Write the failing tests** (vitest, node environment, Node 22 Web Crypto)

```ts
import { challengeFor, decodeJwt } from "../dashboard/console/auth.js";
import { createApi, AuthError, messageFor } from "../dashboard/console/api.js";
import { parseHash } from "../dashboard/console/router.js";
it("computes the RFC 7636 S256 challenge", async () => {
	expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
it("parses routes", () => {
	expect(parseHash("")).toEqual({ view: "overview" });
	expect(parseHash("#/invite/abc_DEF-1")).toEqual({ view: "invite", param: "abc_DEF-1" });
	expect(parseHash("#/nope")).toEqual({ view: "overview" });
});
it("refreshes the token once on 401, then gives up", async () => {
	const getToken = vi.fn().mockResolvedValue("t");
	const fetch = vi.fn().mockResolvedValueOnce(res(401, {})).mockResolvedValueOnce(res(200, { ok: 1 }));
	expect(await createApi({ getToken, fetch }).get("/v1/orgs")).toEqual({ ok: 1 });
	expect(getToken).toHaveBeenLastCalledWith({ force: true });
	fetch.mockResolvedValue(res(401, {}));
	await expect(createApi({ getToken, fetch }).get("/v1/orgs")).rejects.toBeInstanceOf(AuthError);
	expect(fetch).toHaveBeenCalledTimes(4);
});
it("sends the ID token and JSON", async () => { /* post → headers authorization "Bearer t", content-type application/json, body JSON */ });
it("explains limits in plain words", () => expect(messageFor(409, { error: "limit reached", limit: "max_keys" })).toBe("You've reached your plan's limit (max_keys)."));
it("decodes a JWT payload", () => expect(decodeJwt(`x.${btoa(JSON.stringify({ email: "a@x.io" })).replace(/=+$/, "")}.y`)).toEqual({ email: "a@x.io" }));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/console-web.spec.ts`
Expected: FAIL, files not found.

- [ ] **Step 3: Implement the shell modules**
  - `console/index.html` links `../tokens.css`, `../components.css` and `console.css`, and loads only `<script type="module" src="app.js">`.
  - The header markup matches the demo's `.bar`. The org switcher is a `<select>`.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/console-web.spec.ts`
Expected: PASS.

Then use the local preview from Task 11 with `dashboard/config.json` = `{"demoKey":"","auth":{"domain":"https://example.invalid","clientId":"x"}}`:
- `/console/index.html` shows the sign-in/sign-up screen.
- `read_console_messages` shows no errors.
- The Sign in button's target URL, read with `find`/`read_page`, contains `code_challenge_method=S256`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/console test/console-web.spec.ts
git commit -m "Add the console shell: PKCE sign-in, a refreshing API client and hash routing"
```

---

### Task 13: Console views

**Files:**
- Create: `dashboard/console/views/orgs-new.js`, `overview.js`, `traces.js`, `keys.js`, `team.js`, `usage.js`, `settings.js`, `invite.js`
- Modify: `dashboard/console/console.css`
- Test: `test/console-views.spec.ts`, only for the pure helpers listed below

**Interfaces:**
- Consumes: the `ctx` from Task 12; the API shapes from Task 6; `shared/charts.js` and `shared/format.js` (Task 11).
- Produces:
  - Each view exports `render(root: HTMLElement, ctx): Promise<void>`.
  - Pure helpers, exported for tests:
    - `overview.js` exports `curlQuickstart(endpoint: string, key: string): string`. The command matches the README's `curl -X POST "$API_URL/v1/traces"` example, with the endpoint and key filled in and a generated UUID and timestamp.
    - `usage.js` exports `usageRows(usage): { label: string; used: number; limit: number; note: string }[]`. The rows, in order: Events this minute, Events today, Analytics queries today, Eval samples last night, Keys, Members, Pending invites. Each note says what happens at the cap: "Ingest returns 429 until UTC midnight" for events today, and similar.

Screens, per spec §7:
- **orgs-new:** a form with a name (1–100) that POSTs `/v1/orgs`, then shows the key once in a `<dialog>` with copy and "I've saved it".
- **overview:** endpoint `location.origin` (CloudFront fronts the API), the curl quickstart with a `<your key>` placeholder unless the key was just created, and SDK tabs marked "coming soon".
- **traces:** reuses the shared chart and table code against `/v1/orgs/{id}/traces`, `analytics/summary` and `evals`.
- **keys:** list, create (name and scope) with a secret dialog, and revoke with a confirmation.
- **team:**
  - members table, with role changes and removal for owners and "Leave" for yourself
  - pending invites
  - invite form → shows the link with a copy button and the expiry date
- **usage:** one bar per `usageRows` entry (`magnitude` from `shared/charts.js`).
- **settings** (owner controls hidden for members):
  - name
  - rubric `<textarea maxlength=4000>` with a placeholder of `default_rubric` and "Reset to default", which sends `rubric: null`
  - evals toggle
  - danger zone: type the org name to enable Delete, then `DELETE` with `{ confirm_name }`, then `refreshOrgs()`
- **invite:**
  1. If not signed in, `signIn` (the token was already saved by the shell).
  2. `POST /v1/invites/accept`, then switch to the org.
  3. A 404 shows "This invite is invalid, expired or for a different email address."

- [ ] **Step 1: Write the failing tests**

```ts
it("builds a working curl quickstart", () => {
	const c = curlQuickstart("https://d1.cloudfront.net", "tw_x");
	expect(c).toContain('-X POST "https://d1.cloudfront.net/v1/traces"');
	expect(c).toContain('authorization: Bearer tw_x');
	expect(c).toMatch(/"event_id":"[0-9a-f-]{36}"/);
});
it("lists usage against every limit, with what happens at the cap", () => {
	const rows = usageRows({ limits: FREE_LIMITS, used: { events_this_minute: 1, events_today: 2, analytics_queries_today: 3, eval_samples_last_night: 4, keys: 1, members: 1, pending_invites: 0 } });
	expect(rows.map((r) => r.label)).toEqual(["Events this minute", "Events today", "Analytics queries today", "Eval samples last night", "Keys", "Members", "Pending invites"]);
	expect(rows[1]).toMatchObject({ used: 2, limit: 50_000 });
	expect(rows.every((r) => r.note.length > 0)).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/console-views.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the views.** Every API string goes through `el()` as text. Copy buttons use `navigator.clipboard.writeText` and fall back to selecting the text.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/console-views.spec.ts`
Expected: PASS.

Then check the screens in the local preview:
1. Stub the API by running `javascript_tool` in the page to override `window.fetch` with canned responses for `/v1/orgs`, keys, members, invites and usage. This is for inspection only, not committed code.
2. Walk each route with `navigate` to `#/keys`, `#/team` and so on, and `read_page` to confirm its content renders.
3. Use `resize_window` mobile to check that nothing scrolls horizontally.
4. Use `resize_window` with `colorScheme` dark to check contrast.
5. Take a screenshot of `#/keys` as proof.

- [ ] **Step 5: Commit**

```bash
git add dashboard/console test/console-views.spec.ts
git commit -m "Add console screens: create org, overview, traces, keys, team, usage, settings and invites"
```

---

### Task 14: Operator scripts and migration

**Files:**
- Create: `scripts/lib/migrate.ts`, `scripts/migrate-accounts.ts`, `scripts/set-limits.ts`, `scripts/lib/stack.ts`
- Modify: `scripts/create-tenant.ts`, `scripts/create-key.ts`, `package.json` (the Cognito dev dependency), `pnpm-workspace.yaml`
- Test: `test/migrate.spec.ts`

**Interfaces:**
- Consumes: `createOrg`, `createKey`, `updateProfile`, `findOrgByName` (Task 5); `legacyLimits`, the types and `k` (Task 1).
- Produces:
  - `scripts/lib/stack.ts`: `stackOutputs(): Promise<Record<string, string>>`. It holds the `DescribeStacks` call that is currently copied into both scripts, and sets `process.env.ACCOUNTS_TABLE`, `TENANTS_TABLE` and `CONSOLE_ORIGIN` from the outputs.
  - `interface LegacyRow { key_hash; tenant_id; name; status; events_per_minute: number; scope?: "read" | "write"; rubric?: string; created_at: string; org_id?: string }`
  - `planMigration(rows: LegacyRow[], existingProfiles: Set<string>, owner?: { sub: string; email: string }, now = new Date().toISOString()): { profiles: OrgProfile[]; members: Member[]; keys: KeyRecord[]; index: KeyIndexRow[] }`
    - Rows that already have `org_id` are skipped.
    - Each `tenant_id` gets a profile, unless it's already in `existingProfiles`: plan `custom`, `limits: legacyLimits(epm)`, the row's rubric, `evals_enabled: true`, `owner_count: owner ? 1 : 0`.
    - `key_id` is `key_hash.slice(0, 16)`, so a second run produces the same IDs.
    - `prefix` is `"tw_••••••"`, and the name is `"Legacy read key"` or `"Legacy key"`.
  - `scripts/migrate-accounts.ts [--owner email]`:
    1. Scans the key index.
    2. Reads the existing profiles.
    3. Resolves the owner through `ListUsers` filtered on `email = "<email>"`.
    4. Writes each plan item with a condition: `attribute_not_exists(pk)` for new items, and for key-index rewrites a `PutCommand` with `attribute_not_exists(org_id)` (the lean shape).
    5. Prints counts.
  - `scripts/set-limits.ts "<org name or id>" key=value…` validates the keys against `Limits` and calls `updateProfile(id, { limits, plan: "custom" })`.
  - `create-tenant.ts "<name>" [eventsPerMinute]` calls `createOrg({ name, plan: "custom", limits: legacyLimits(perMinute) })` and prints the key and endpoint as it does today.
  - `create-key.ts "<org name>" [read|write]` calls `findOrgByName` then `createKey(..., created_by: "operator")`.

- [ ] **Step 1: Write the failing tests**

```ts
const demo: LegacyRow = { key_hash: "a".repeat(64), tenant_id: "t1", name: "Acme Support", status: "active", events_per_minute: 6000, scope: "read", created_at: "2026-10-01T00:00:00Z" };
const write: LegacyRow = { ...demo, key_hash: "b".repeat(64), scope: undefined };
it("creates one profile per tenant that keeps the demo and load test working", () => {
	const p = planMigration([demo, write], new Set());
	expect(p.profiles).toHaveLength(1);
	expect(p.profiles[0]).toMatchObject({ org_id: "t1", plan: "custom", owner_count: 0, limits: { events_per_minute: 6000, events_per_day: 8_640_000, analytics_queries_per_day: 10_000 } });
	expect(p.index).toEqual([
		{ key_hash: demo.key_hash, org_id: "t1", key_id: "aaaaaaaaaaaaaaaa", scope: "read", status: "active" },
		{ key_hash: write.key_hash, org_id: "t1", key_id: "bbbbbbbbbbbbbbbb", scope: "write", status: "active" },
	]);
});
it("is idempotent", () => {
	const once = planMigration([demo], new Set());
	const migrated = { ...demo, org_id: "t1" };
	expect(planMigration([migrated], new Set(["t1"]))).toEqual({ profiles: [], members: [], keys: [], index: [] });
	expect(planMigration([demo], new Set(["t1"])).keys).toEqual(once.keys);
});
it("attaches an owner when given one", () => {
	const p = planMigration([demo], new Set(), { sub: "u1", email: "z@x.io" });
	expect(p.members).toEqual([expect.objectContaining({ org_id: "t1", sub: "u1", role: "owner" })]);
	expect(p.profiles[0]!.owner_count).toBe(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/migrate.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the scripts.** Install the Cognito client:

```bash
pnpm add -D @aws-sdk/client-cognito-identity-provider@3.1155.0
```

Add it to `minimumReleaseAgeExclude` first, if pnpm refuses it.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/migrate.spec.ts && pnpm typecheck && pnpm test`
Expected: PASS. `typecheck` is clean now, and the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add scripts test/migrate.spec.ts package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "Migrate existing tenants into orgs, and route operator scripts through the console store"
```

---

### Task 15: Self-serve smoke test and docs

**Files:**
- Create: `scripts/smoke-selfserve.ts`
- Modify: `README.md`, `docs/design.md`, `docs/superpowers/specs/2026-10-22-self-serve-accounts-design.md` (append "Changes during planning", with the 11 decisions above)

**Interfaces:**
- Consumes: the `stackOutputs()` outputs `UserPoolId`, `SmokeClientId` and `DashboardUrl`; every console route.

`smoke-selfserve.ts` follows `smoke.ts`'s `check()` style and runs these steps against `DashboardUrl`:
1. `AdminCreateUser` with emails `smoke-<runId>-a@example.com` and `-b@example.com`, `email_verified=true`, `MessageAction: SUPPRESS`, then `AdminSetUserPassword` with `Permanent: true`, then `AdminInitiateAuth ADMIN_USER_PASSWORD_AUTH` to get the `IdToken`.
2. `POST /v1/orgs`.
3. Ingest 5 events with the returned key through the SDK.
4. Poll `GET /v1/orgs/{id}/traces` until all 5 arrive (30 s).
5. User A invites B, and B accepts. B's `GET /v1/orgs` lists the org.
6. B gets 403 on `PATCH /v1/orgs/{id}`.
7. Revoke the key, wait 65 s, and confirm ingest returns 401.
8. `DELETE /v1/orgs/{id}`, then poll for up to 20 minutes until `LakeBucket` has no `traces/tenant_id=<id>/` objects and the trace query returns 404.
9. `AdminDeleteUser` both users, in a `finally` block.
10. Exit non-zero on any failure.

The script needs `s3:ListBucket` through the operator's credentials, as the other scripts have.

- [ ] **Step 1: Write the script and run it against a deployed stack.** Follow the README order: deploy with `--context smokeClient=true`, then migrate, then run the smoke test.

```bash
TRACEWISE_ALARM_EMAIL=you@example.com TRACEWISE_DASHBOARD_KEY=<read-only key> pnpm run deploy --context smokeClient=true
```
```bash
pnpm exec tsx scripts/migrate-accounts.ts
```
```bash
pnpm exec tsx scripts/smoke-selfserve.ts
```

Expected: every line `✓`, exit 0. Then rerun `scripts/smoke.ts` with the existing key, and the public demo must still load. Check the demo with `preview_start { url: DashboardUrl }` and `read_console_messages`.

- [ ] **Step 2: Update the docs**
  - **README:**
    - a "Sign up" section with the console link and the 30-second flow
    - free limits and the global caps
    - `migrate-accounts`, `set-limits`, `smoke-selfserve` in "Run it"
    - Cognito's 50-emails-a-day note
    - the lake prefixes that deletion leaves to lifecycle
    - an architecture bullet for accounts
  - **`design.md`:** replace the "read-only keys instead of Cognito (for now)" decision with what was built, and move self-serve out of non-goals.
  - **Spec:** append "Changes during planning".

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-selfserve.ts README.md docs
git commit -m "Smoke-test self-serve end to end and document sign-up, limits and migration"
```

---

### Task 16: Remove the old key-row fallback (only after the migration has run everywhere)

**Files:**
- Modify: `services/shared/tenants.ts`, `services/evals/handlers.ts`
- Test: `test/tenants.spec.ts`, `test/evals-handlers.spec.ts`

**Precondition:** `scripts/migrate-accounts.ts` has run in every deployed environment, and a scan of the key index finds no row without `org_id`:

```bash
aws dynamodb scan --table-name <TenantsTable> --filter-expression "attribute_not_exists(org_id)" --select COUNT
```

Expected `"Count": 0`.

- [ ] **Step 1: Change the fallback tests** to expect that an old-shape row resolves to `null` and isn't listed for evals.
- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/tenants.spec.ts test/evals-handlers.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Delete the fallback branches**, and the key-index scan in `listTenants` along with its IAM grant in the stack.
- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services test infra
git commit -m "Remove the pre-accounts key-row fallback now that every tenant is migrated"
```
