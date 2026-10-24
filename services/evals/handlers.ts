import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { log } from "../shared/http";
import { partitionsForDay } from "../shared/keys";
import { GLOBAL_JUDGE_CALLS_PER_NIGHT, PAID_JUDGE_CALLS_PER_NIGHT, getProfile, legacyLimits, listProfiles } from "../shared/accounts";
import { ddb } from "../shared/ddb";
import { counterIds } from "../shared/tenants";
import { DEFAULT_RUBRIC, isRegression, judgeMessages, parseScores, summarize, type Graded } from "./judge-prompt";

// The four steps of the nightly evaluation workflow. Step Functions passes only small
// payloads between them (keys, not transcripts): its state limit is 256 KB, and a
// sample of full conversations could exceed it. Each judge call fetches its own trace.

const bedrock = new BedrockRuntimeClient({});
const cloudwatch = new CloudWatchClient({});
const sns = new SNSClient({});
// Most traces judged for one org in a night. Sized for Pro's 500-sample allowance; read at
// call time so a run can lower it without a redeploy.
const sampleSize = () => Number(process.env.SAMPLE_SIZE ?? 500);

interface TenantRef {
	tenant_id: string;
	name: string;
	// Always present (null for the default) because Step Functions fails on a missing path.
	rubric: string | null;
	day: string;
	// Judge calls this org may use tonight: its own limit, or its share of the global cap
	// when that is smaller. Both travel with the run so the shortfall can be recorded.
	sample_budget: number;
	sample_limit: number;
}

// Step 1: every active org with evals on, with the day to evaluate (yesterday by default)
// and its judge budget: a share of the free pool, or its own allowance for paid orgs.
// Tenants that predate self-serve have no profile yet, only key rows, so those are read too
// until the migration has rewritten them. The table holds one item per API key and a tenant
// can have several (e.g. a read-only dashboard key), so they are de-duplicated by id.
export async function listTenants(input: { day?: string }): Promise<{ tenants: TenantRef[] }> {
	const day = input.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	const candidates: { tenant_id: string; name: string; rubric: string | null; limit: number; pooled: boolean }[] = [];
	const seen = new Set<string>();

	for (const p of await listProfiles()) {
		// Every profile is covered, whatever its status or evals setting, so an old key row can't
		// re-enable evals or bring back an org that is suspended, deleting or deleted.
		seen.add(p.org_id);
		// Rubrics (up to 4,000 characters each) stay out of this state, which Step Functions
		// caps at 256 KB across every org; the sample step loads them.
		// Anything that isn't a known paid plan stays in the pool, so an odd row can't spend outside it.
		const pooled = p.plan !== "team" && p.plan !== "pro" && p.plan !== "custom";
		if (p.status === "active" && p.evals_enabled) candidates.push({ tenant_id: p.org_id, name: p.name, rubric: null, limit: p.limits.eval_samples_per_night, pooled });
	}

	let start: Record<string, unknown> | undefined;
	do {
		const page = await ddb.send(new ScanCommand({ TableName: process.env.TENANTS_TABLE, ExclusiveStartKey: start }));
		for (const t of page.Items ?? []) {
			if (t.org_id || t.status !== "active" || seen.has(t.tenant_id)) continue;
			seen.add(t.tenant_id);
			candidates.push({
				tenant_id: t.tenant_id,
				name: t.name,
				rubric: t.rubric ?? null,
				limit: legacyLimits(t.events_per_minute).eval_samples_per_night,
				// Legacy rows count as custom orgs: they predate the pool and keep their own allowance.
				pooled: false,
			});
		}
		start = page.LastEvaluatedKey;
	} while (start);

	// Only free orgs share the pool, split equally: simple and predictable, and budget an org
	// doesn't use isn't redistributed. Paid and custom orgs sit outside it, so they neither
	// shrink the free share nor get shrunk by it. SAMPLE_SIZE still caps what one run judges.
	const share = Math.floor(GLOBAL_JUDGE_CALLS_PER_NIGHT / Math.max(candidates.filter((c) => c.pooled).length, 1));
	// Everyone outside the pool together stays under PAID_JUDGE_CALLS_PER_NIGHT: when they ask for more,
	// each gets the same fraction of what it asked for (rounded down), so the total never exceeds it.
	// This ceiling exists only for the single execution's history limit; a Distributed Map (the
	// eval-scaling follow-up) removes it.
	const paidAsk = candidates.reduce((n, c) => n + (c.pooled ? 0 : Math.min(c.limit, sampleSize())), 0);
	const paidCapped = paidAsk > PAID_JUDGE_CALLS_PER_NIGHT;
	const tenants = candidates.map(({ limit, pooled, ...c }) => {
		const own = Math.min(limit, sampleSize());
		return {
			...c,
			day,
			sample_budget: pooled ? Math.min(limit, share) : paidCapped ? Math.floor((own * PAID_JUDGE_CALLS_PER_NIGHT) / paidAsk) : own,
			sample_limit: limit,
		};
	});

	// "judge" is about the free pool running short; a paid org trimmed by SAMPLE_SIZE isn't that.
	// "judge_paid" is the paid ceiling above binding.
	const freeShort = candidates.some((c, i) => c.pooled && tenants[i]!.sample_budget < tenants[i]!.sample_limit);
	const caps = [...(freeShort ? ["judge"] : []), ...(paidCapped ? ["judge_paid"] : [])];
	if (caps.length > 0) {
		try {
			await cloudwatch.send(
				new PutMetricDataCommand({
					Namespace: "Tracewise/Limits",
					MetricData: caps.map((cap) => ({ MetricName: "GlobalCapHit", Dimensions: [{ Name: "Cap", Value: cap }], Value: 1, Unit: "Count" as const })),
				}),
			);
		} catch (e) {
			// Reporting is best effort: a CloudWatch blip mustn't cost the night's evaluation.
			log("warn", "could not publish GlobalCapHit", { error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { tenants };
}

// Step 2: a random sample of the tenant's successful, unblocked calls for the day (at most
// its judge budget), returned as keys only.
export async function sample(tenant: TenantRef): Promise<TenantRef & { keys: { pk: string; sk: string }[] }> {
	// The org may have been suspended or started deleting since ListTenants ran. No keys sends
	// the workflow's AnyTraces choice to NothingToGrade.
	const profile = await getProfile(tenant.tenant_id);
	if (profile && profile.status !== "active") {
		log("info", "sample skipped: org not active", { tenant_id: tenant.tenant_id, status: profile.status });
		return { ...tenant, rubric: null, keys: [] };
	}
	const pages = await Promise.all(
		partitionsForDay(tenant.tenant_id, tenant.day).map((pk) =>
			ddb.send(
				new QueryCommand({
					TableName: process.env.TRACES_TABLE,
					KeyConditionExpression: "pk = :pk",
					FilterExpression: "#s = :ok AND (attribute_not_exists(security) OR security.verdict <> :blocked)",
					ExpressionAttributeNames: { "#s": "status" },
					ExpressionAttributeValues: { ":pk": pk, ":ok": "ok", ":blocked": "blocked" },
					ProjectionExpression: "pk, sk",
				}),
			),
		),
	);
	const all = pages.flatMap((p) => (p.Items ?? []) as { pk: string; sk: string }[]);
	// Fisher-Yates shuffle, then take the sample.
	for (let i = all.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[all[i], all[j]] = [all[j]!, all[i]!];
	}
	const keys = all.slice(0, Math.min(tenant.sample_budget, sampleSize()));

	// The usage route reads the night's count from here, so it needs no access to eval runs.
	await ddb.send(
		new PutCommand({
			TableName: process.env.QUOTAS_TABLE,
			Item: { window: counterIds.evals(tenant.tenant_id, tenant.day), used: keys.length, expires_at: Math.floor(Date.now() / 1000) + 3 * 86_400 },
		}),
	);

	// The judge step reads the rubric from this output. A profile's rubric wins (it may be
	// null for the default); a tenant with no profile yet carries its own on the ref.
	const rubric = profile ? profile.rubric : tenant.rubric ?? null;
	return { ...tenant, rubric, keys };
}

// Step 3 (run in parallel by a Map state): grade one trace. Throttling errors are
// rethrown so Step Functions retries them with backoff; anything else is recorded as
// a failed grade rather than failing the whole run.
export async function judge(input: { key: { pk: string; sk: string }; rubric: string | null }): Promise<Graded> {
	const { Item } = await ddb.send(new GetCommand({ TableName: process.env.TRACES_TABLE, Key: input.key }));
	if (!Item) return { key: input.key, event_id: "", route: "", scores: null, error: "trace expired or missing" };

	const { system, user } = judgeMessages(String(Item.input), String(Item.output), input.rubric ?? DEFAULT_RUBRIC);
	const res = await bedrock.send(
		new ConverseCommand({
			modelId: process.env.JUDGE_MODEL,
			system: [{ text: system }],
			messages: [{ role: "user", content: [{ text: user }] }],
			inferenceConfig: { maxTokens: 200, temperature: 0 },
		}),
	);
	const text = res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
	const scores = parseScores(text);
	if (!scores) log("warn", "judge reply unparseable", { event_id: Item.event_id });
	return { key: input.key, event_id: Item.event_id, route: Item.route ?? "(none)", scores, ...(scores ? {} : { error: "unparseable judge reply" }) };
}

// Step 4: store the run, publish metrics, and alert on a regression.
export async function record(input: TenantRef & { results: Graded[] }) {
	// Grading can take a while: an org that started deleting meanwhile gets no run, metric or
	// alert. A run that slips in just before this check is removed by the deleter's sweep.
	const profile = await getProfile(input.tenant_id);
	if (profile && profile.status !== "active") {
		log("info", "eval run not recorded: org not active", { tenant_id: input.tenant_id, status: profile.status });
		return { tenant_id: input.tenant_id, meanOverall: null, scored: 0, regressed: false, skipped: true };
	}
	const summary = summarize(input.results);
	const runAt = new Date().toISOString();

	const previous = await ddb.send(
		new QueryCommand({
			TableName: process.env.EVALS_TABLE,
			KeyConditionExpression: "tenant_id = :t",
			ExpressionAttributeValues: { ":t": input.tenant_id },
			ScanIndexForward: false,
			Limit: 7,
		}),
	);
	const baseline = (previous.Items ?? []).map((r) => r.meanOverall).filter((m): m is number => typeof m === "number");
	const regressed = isRegression(summary.meanOverall, baseline);

	await ddb.send(
		new PutCommand({
			TableName: process.env.EVALS_TABLE,
			Item: {
				tenant_id: input.tenant_id,
				run_at: runAt,
				day: input.day,
				judge_model: process.env.JUDGE_MODEL,
				regressed,
				sample_budget: input.sample_budget,
				sample_shortfall: input.sample_limit - input.sample_budget,
				...summary,
				expires_at: Math.floor(Date.now() / 1000) + 400 * 86_400,
			},
		}),
	);

	if (summary.meanOverall !== null) {
		const dims = (route?: string) => [
			{ Name: "Tenant", Value: input.tenant_id },
			...(route ? [{ Name: "Route", Value: route }] : []),
		];
		await cloudwatch.send(
			new PutMetricDataCommand({
				Namespace: "Tracewise/Evals",
				MetricData: [
					{ MetricName: "MeanScore", Dimensions: dims(), Value: summary.meanOverall },
					{ MetricName: "SafetyFailures", Dimensions: dims(), Value: summary.safetyFailures, Unit: "Count" },
					...Object.entries(summary.byRoute).map(([route, r]) => ({ MetricName: "MeanScore", Dimensions: dims(route), Value: r.meanOverall })),
				],
			}),
		);
	}

	if (regressed || summary.safetyFailures > 0) {
		const base = baseline.length ? (baseline.reduce((a, b) => a + b, 0) / baseline.length).toFixed(2) : "n/a";
		await sns.send(
			new PublishCommand({
				TopicArn: process.env.ALERT_TOPIC,
				Subject: `Tracewise: ${regressed ? "quality regression" : "safety failures"} for ${input.name}`.slice(0, 100),
				Message: [
					`Tenant: ${input.name} (${input.tenant_id})`,
					`Day evaluated: ${input.day}`,
					`Mean score: ${summary.meanOverall} (7-run baseline: ${base})`,
					`Safety failures: ${summary.safetyFailures} of ${summary.scored}`,
					"",
					"Lowest-scoring traces:",
					...summary.worst.map((w) => `- ${w.overall.toFixed(1)}  ${w.route}  ${w.event_id}  ${w.reason}`),
				].join("\n"),
			}),
		);
	}

	log("info", "eval run recorded", { tenant_id: input.tenant_id, day: input.day, ...summary, regressed, worst: undefined });
	return { tenant_id: input.tenant_id, meanOverall: summary.meanOverall, scored: summary.scored, regressed };
}
