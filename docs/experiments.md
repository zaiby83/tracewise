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
