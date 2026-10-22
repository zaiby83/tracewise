# Tracewise: PR/FAQ

*Written working backwards, Amazon-style: the press release for the finished product, then the questions a customer and a stakeholder would ask, before any code exists.*

---

## Press release

### Tracewise shows teams whether their AI features are getting better or worse, and what they cost, before customers notice

**Teams shipping LLM features can now trace every model call, catch quality regressions automatically, and see cost per customer, with two lines of code.**

Today, most teams ship AI features blind. A prompt tweak, a model upgrade or a change in user behaviour can quietly make answers worse, leak data, or double the inference bill, and the team finds out from a customer complaint or an invoice. Logs exist, but they're scattered across providers, unsearchable, and say nothing about whether an answer was any *good*.

Tracewise fixes that. Developers add the Tracewise SDK to their app, and every LLM call (prompt, response, model, latency, tokens, cost and any security verdicts) streams to Tracewise. Each night, Tracewise samples recent traffic and grades it with an automated judge against the team's own quality criteria. When quality drops, cost spikes, or attacks rise, the team gets an alert with the exact traces that changed.

"We changed one line in a system prompt and our answer quality fell 12% for a week before anyone noticed," said a (hypothetical) engineering lead at a mid-size SaaS company. "With Tracewise, that would have been an alert the next morning, with the ten worst examples attached."

Tracewise runs entirely on serverless AWS services, so there's nothing to provision or patch. It scales from a side project to tens of thousands of events a second, and it isolates each customer's data. It also works alongside **Prompt Shield**, the open-source prompt-injection firewall, so security verdicts and quality scores appear in the same dashboard.

To get started, install the SDK (`npm install @tracewise/sdk` or `pip install tracewise`), wrap your model client, and open the dashboard.

---

## Customer FAQ

**What does it cost me to run?**
At demo and small-team volumes, it runs largely inside AWS's free tiers. Every component is pay-per-use, so cost tracks traffic. Nothing bills while idle except stored data.

**Will it slow down my app?**
No. The SDK batches events and sends them in the background, so a Tracewise outage never blocks or fails your model calls. Events are buffered and retried, and dropped only after a bounded queue fills.

**Is my data safe? Prompts can contain customer information.**
Each tenant's data is partitioned by tenant ID at every layer and encrypted at rest. API keys are stored hashed. Traces expire automatically after a configurable retention period. The SDK can redact fields before they leave your app.

**Which model providers work?**
Any. Tracewise records what you send it: OpenAI, Anthropic, Bedrock, Workers AI, or your own models.

**How is "quality" measured?**
You define it with evaluators: an LLM judge with your rubric, plus deterministic checks (format, length, banned content, latency budgets). Scores are tracked per evaluator over time, so a regression points at what got worse.

---

## Internal FAQ

**Why build on AWS rather than the Cloudflare stack Prompt Shield uses?**
Different shapes of work. Prompt Shield sits in the request path and needs to be fast everywhere, so it's at the edge. Tracewise is a data platform: durable queues, batch analytics, scheduled workflows and cheap long-term storage. AWS's managed services for those are mature and well integrated. The two talk over plain HTTPS, which is also a realistic multi-cloud architecture.

**What's the hardest technical problem?**
Ingestion under bursty load without losing events or overcharging for capacity, while keeping tenants isolated. That drives most of the design: an API that only validates and enqueues, a queue that absorbs bursts, and batch consumers that write to storage.

**What does "done" look like for v1?**
1. The SDK sends traces.
2. Ingestion sustains a measured throughput with a published p99 latency from a load test.
3. Traces are queryable per tenant.
4. A nightly eval workflow scores samples and raises an alarm on regression.
5. A dashboard shows quality, cost and security over time.
6. The entire stack deploys with one `cdk deploy`.

**What's explicitly out of scope for v1?**
Billing, SSO/SAML, a self-hosted version, real-time streaming dashboards, and prompt management.

**Biggest risks?**
- Runaway AWS cost from a bug or abuse. Mitigated by per-tenant quotas, budget alarms and on-demand capacity with limits.
- An LLM judge that's noisy. Mitigated by calibrating it against a small human-labelled set, the same approach that chose Prompt Shield's judge.
