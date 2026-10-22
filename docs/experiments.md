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

## 3. Choosing and trusting the evaluation judge

**Question.** The nightly evaluation uses an LLM to grade answers. Which Bedrock model should do it, and can its grades be trusted?

**Method.** `eval/conversations.json` holds 24 hand-labelled conversations: 12 good and 12 bad. The bad ones are deliberately varied: wrong facts, a hallucinated feature, off-topic answers, a leaked secret, an obeyed prompt injection, wrong and dangerous SQL, an unhelpful refusal, a wrong summary, a rude email and a made-up policy. `scripts/calibrate-judge.ts` sends every case to each candidate model through the same prompt and parser the workflow uses, and compares "overall < 3" against the labels.

**Results**

| Judge | Agreement | Bad answers caught | Good answers wrongly failed |
|---|---|---|---|
| Amazon Nova 2 Lite | 22/24 (twice) | 10/12 | 0/12 |
| **Amazon Nova Pro** | **23/24, then 24/24** | **11–12/12** | **0/12** |
| Meta Llama 3.3 70B | 20/24 | 8/12 | 0/12 |
| Anthropic Claude Haiku 5.5 | not available | – | – |

Claude models on Bedrock require a one-time use-case submission on new accounts, which wasn't needed for this.

**Observations**
- **No model failed a good answer.** Every miss was a bad answer graded too kindly, and almost all of those scored exactly 3.0, the cut-off. Llama missed "rude", "off-topic" and "unhelpful refusal": it graded factual accuracy well but tone and helpfulness poorly.
- **The judge isn't perfectly repeatable, even at temperature 0.** Nova Pro graded the borderline "unhelpful refusal" differently on two runs. That's why the workflow averages a sample of 20 per tenant per day and alerts on a drop of 0.5 or more against a 7-run baseline, rather than reacting to any single grade.
- **A threshold sweep** showed Nova Pro's good answers all scored 4.5–5.0, so any cut-off from 2.5 to 4 gives the same result. Nova 2 Lite needed a looser cut-off (< 3.5) to catch one more bad answer.

**Decision.** Nova Pro is the default judge (`-c judgeModel=…` to change). A nightly run of 20 samples uses about 7k tokens, a fraction of a cent.

### End-to-end: detecting a bad deploy

I created a separate demo tenant and seeded four days of realistic traffic: three normal days (10% bad answers) and a "bad deploy" day (70% bad), then ran the workflow for each day in order.

| Day | Mean score (1–5) | Safety failures | Regression? |
|---|---|---|---|
| Oct 18 | 4.53 | 0 | – |
| Oct 19 | 4.50 | 0 | – |
| Oct 20 | 4.48 | 0 | – |
| **Oct 21** | **2.45** | **4** | **yes: alert published to SNS** |

The run's "worst traces" named the planted failures in the judge's own words: *"Invented feature, unrealistic claims"*, *"Incorrect information about plan change timing"*, *"Harmful misinformation given"*. Each workflow run took about 9 seconds.

**The first run was a useful failure too.** The original demo tenant's traffic was synthetic filler ("question 12" → "answer 12"), and the judge correctly scored all of it 1/5 ("Generic, non-informative response"). Garbage in, an honest grade out, and the reason a separate tenant holds the realistic demo data.

## 4. Load test: 1,000 events/s sustained, 5× burst, zero loss

**Question.** The design targets 1,000 events/s sustained and a 5× burst for 60 s, with no acknowledged event lost. Does the deployed system meet that, and where does it break?

**Method.** `scripts/loadtest.ts` is an **open-loop** generator. It sends 50-event batches on a fixed schedule whether or not earlier requests have finished, so a slowing server can't throttle the test and hide its own latency (coordinated omission). It reports any request it couldn't issue instead of dropping it silently. It ran from a laptop against the live API, with a dedicated tenant. `scripts/loadtest-metrics.ts` pulled the server side per minute from CloudWatch. Afterwards, every accepted event was reconciled against both stores.

### Run 1: 1,000 events/s for 3 min, batch 10 with no window (the latency-optimized config)

| Minute | Into SQS | Processed | Backlog | Oldest message |
|---|---|---|---|---|
| 1 | 53,100 | 33,535 | 0 | 0 s |
| 2 | 59,500 | 37,180 | 23,106 | 24 s |
| 3 | 59,500 | 36,770 | 45,355 | 48 s |
| after | 7,000 | 44,990 | 51,485 | 54 s |

- **The processor fell behind at ~615 events/s**, close to the ~500/s predicted beforehand. Each invocation took only **16 ms (p50)**, so the limit wasn't compute. It was the fixed per-batch cost of the SQS poll → invoke → delete cycle, at 10 messages per batch and a concurrency of 7.
- **26 requests (1,300 events) got 503s, all from Lambda throttling, not from Tracewise code.** The account's concurrent-execution limit was **10**. AWS's default is 1,000, but **new accounts start at 10**, and every function shares it. CloudWatch showed exactly 26 ingest throttles.

### Run 2: same load, batch 100 with a 1 s window

| | Run 1 (batch 10, 0 s) | **Run 2 (batch 100, 1 s)** |
|---|---|---|
| Accepted | 992/s, 26 throttled requests | **999/s, 0 throttled** |
| Backlog | grew to 51,485 | **0 every minute** |
| Processor concurrency | 7 | **4–5** |
| Freshness at low traffic (p50 / p90) | **63 ms / 99 ms** | 4.7 s / 12.9 s |

Bigger batches cut the per-event overhead roughly tenfold, so the processor kept up with **fewer** concurrent executions. That also left more of the 10-slot limit for ingest. The cost is freshness at low traffic: with little traffic, the batching window and SQS polling dominate.

### Run 3: burst, 1,000 → 5,000 → 1,000 events/s (60 s each), batch 100

| Minute | API 5xx | Ingest concurrency | Backlog | Oldest | DynamoDB write throttles |
|---|---|---|---|---|---|
| 1,000/s | 0 | 5 | 0 | 0 s | 0 |
| **5,000/s** | 428 | **10 (limit)** | 0 | 0 s | 0 |
| after burst | 172 | 10 | **185,662** | 46 s | **8,180** |
| 1,000/s | 2 | 4 | 139,975 | 91 s | 19,877 |
| drain | – | – | 13,985 | 87 s | 3,772 |

- **4,477 events/s accepted during the burst (90%).** The rest were clean 503s from Lambda throttling, which the SDK retries with backoff and jitter.
- **A second hidden limit: DynamoDB on-demand throttled writes.** A new on-demand table starts with limited throughput and scales up as traffic grows. The processor's backoff retries plus SQS redelivery absorbed it, with **0 dead letters and 0 processor errors**.
- The queue did what it's there for: it soaked up a 185k-message backlog and drained it within about 3 minutes.

### Reconciliation: did anything get lost?

| | Events |
|---|---|
| Accepted (HTTP 202) across all runs | **751,200** |
| In DynamoDB | **751,200** |
| In the S3 data lake, distinct | **751,200** (751,203 rows: 3 Firehose retry duplicates, handled by counting distinct `event_id`) |

The first DynamoDB count came up 3 short. Those were messages still in their throttle-retry cycle, and a recount minutes later matched exactly. **No acknowledged event was lost, through Lambda throttling, DynamoDB throttling and a 185k-message backlog.**

### Decisions

1. **Default trigger config is now batch 100 with a 1 s window.** At the account's current limit, it's the only config that meets the 1,000/s target, and it still meets the freshness target (p50 < 5 s, p99 < 30 s). This reverses experiment 1's choice, which optimized freshness without measuring throughput. Both are kept in this document because the reversal is the point.
2. **A Lambda concurrency increase to 1,000 has been requested** (AWS support case). With headroom, two follow-ups become worth measuring: (a) batch 10 with no window plus higher `processorConcurrency`, which may recover 63 ms freshness *and* the throughput; (b) the 5,000/s burst with no ingest throttling.
3. **For production, also:** reserve concurrency for the ingest function so the processor can never starve it, and pre-warm the traces table's on-demand throughput (or set a warm throughput) before an expected traffic jump.

*Approximate cost of all runs: ~750k events, about $2–3, mostly DynamoDB writes.*
