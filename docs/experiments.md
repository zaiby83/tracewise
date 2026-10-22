# Experiments

Measurements taken against the deployed stack in `us-east-1`. Each one records the question, the method, what happened, and the decision.

## 1. SQS → Lambda batching: freshness vs. invocation cost

**Question.** The first end-to-end test took 22 s for 250 events to become queryable, although the processor finished each batch in about 300 ms. Where does the time go, and what should the trigger settings be?

**Method.** `scripts/latency.ts` sends 20 single events 3 s apart, so each meets a mostly idle queue, as low traffic would. The processor stamps `processed_at` on every item. Latency is `processed_at − received_at`, measured entirely server-side, so client polling doesn't distort it. Each configuration was deployed with CDK context flags and measured, and the baseline was measured twice to check it was reproducible.

**Results**

| Batch size | Batching window | p50 | p90 | max |
|---|---|---|---|---|
| 100 | 2 s (original) | 6,315 ms | 20,212 ms | 21,894 ms |
| 100 | 2 s (repeat) | 6,434 ms | 20,347 ms | 20,358 ms |
| 100 | 0 s | *rejected by AWS* | | |
| **10** | **0 s** | **63 ms** | **99 ms** | **123 ms** |

**Observations**
- With a batching window, latencies clustered near ~3 s, ~6 s and ~20 s rather than spreading evenly. That pattern points to the event source mapping's polling and batching cycles, not to processing time: the processor's own duration was ~300 ms throughout.
- AWS rejects a batching window of 0 when the batch size is above 10. CloudFormation rolled the stack back automatically, with nothing to clean up.
- Batch size 10 with no window cut latency by about 100×, and the full smoke test went from 22.1 s to 1.4 s until all 200 sampled events were queryable.

**The trade-off.** Smaller batches mean more invocations for the same traffic. Lambda bills per request as well as per GB-second. At the design's sustained 1,000 events/s:

| | Invocations/s | Invocations/month | Request charges/month* |
|---|---|---|---|
| Batch 100 | ~10 | ~26M | ~$5 |
| Batch 10 | ~100 | ~259M | ~$52 |

\* At Lambda's public price of $0.20 per million requests. Compute (GB-seconds) is roughly the same either way, since the total work is the same. Recheck the figures with the AWS Pricing Calculator before quoting them.

**Decision.** The default is now **batch 10, no window**. For an observability product, "I can see the trace I just sent" matters more than about $47/month at a volume the demo won't reach. Both values are CDK context flags (`-c batchSize=… -c batchingWindow=…`), so a high-volume deployment can move back toward larger batches when cost matters more than freshness. The design doc now states a freshness target: p50 < 5 s and p99 < 30 s from ingest to queryable.

**What I'd measure next:** the same comparison under sustained load (Milestone 5's load test). Under load, batches fill on their own, so the window matters less and the cost difference shows up for real.

## 2. The data lake: tenant isolation and what a query actually reads

**Question.** The design claims that the S3 + Parquet + Athena layout isolates tenants and keeps queries cheap: partition projection on `tenant_id` and `dt`, plus columnar storage. Does the deployed system actually behave that way?

**Method.** I seeded 2,000 events over 7 days (`scripts/seed.ts`), let Firehose deliver them as Parquet, then ran queries directly in the `tracewise` Athena workgroup and read `DataScannedInBytes` and engine time from each execution.

**Results**

| Query | Result | Data scanned | Engine time |
|---|---|---|---|
| `SELECT count(*) FROM traces` (no tenant) | **Rejected:** `CONSTRAINT_VIOLATION` | 0 | – |
| One column, one tenant, all 8 days | succeeded | 8.0 KB | 715 ms |
| One column, one tenant, **one day** | succeeded | **1.1 KB** | 455 ms |
| **All columns**, one tenant, all 8 days | succeeded | **160.0 KB** | 772 ms |
| One column, a different (empty) tenant | succeeded | 0 KB | 825 ms |
| API summary, same question repeated within 5 min | reused result | **0 KB** | 567 ms end to end |

**Observations**
- **Tenant isolation is enforced by the query engine, not just by application code.** With `tenant_id` as an *injected* projected partition, Athena refuses any query without an equality filter on it. A bug that forgot the filter would fail loudly instead of reading every tenant's data.
- **Columnar storage:** reading one column scanned about **20× less** than `SELECT *`. That's why the analytics queries name only the columns they need.
- **Date partitioning:** narrowing 8 days to 1 cut the scan about **7×**. Cost scales with the window asked for, not with total retention.
- **Another tenant's query reads none of this tenant's data** (0 bytes), because it resolves to a different S3 prefix.
- **Query-result reuse** made a repeated dashboard question free.
- **No partition maintenance:** projection means no crawlers and no `MSCK REPAIR`. New tenants and days are queryable as soon as Firehose writes them.

**Caveat on cost.** Athena bills $5 per TB scanned with a **10 MB minimum per query**, so at demo volumes every query above costs the same, about $0.00005. The savings from pruning and columns become real at scale: at 1,000 events/s (~86M events/day), a 30-day `SELECT *` would scan hundreds of GB, while a one-column, one-week query reads a small fraction of that. The workgroup's 1 GB per-query scan cap is the backstop against an expensive mistake.

**Decision.** Keep the layout. Next steps would be compaction (Firehose writes many small files per day at low volume, and small files slow Athena down at scale) and, if tenants need SQL access themselves, Lake Formation row-level permissions.
