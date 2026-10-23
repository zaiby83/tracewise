import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { PLANS } from "../../services/billing/plans";
import { CONSOLE_ROUTES, JWT_DATA_ROUTES } from "../../services/console/route-keys";
import { MAX_RETENTION_DAYS } from "../../services/shared/keys";
import { TracewiseStack } from "../lib/tracewise-stack";

// Assertions on the synthesized CloudFormation: the guarantees the design doc makes
// about security and reliability, checked on every change.
let template: Template;
beforeAll(() => {
	const app = new App();
	template = Template.fromStack(new TracewiseStack(app, "Test", { alarmEmail: "alerts@example.com" }));
}, 120_000);

// The only Accounts write the data-plane functions get: touchKey's last_used_at stamp.
const TOUCH_KEY_CONDITION = { "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "last_used_at"] } };

// The IAM policies attached to the roles whose logical IDs match.
const policiesFor = (re: RegExp) =>
	Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => re.test(JSON.stringify(p.Properties.Roles)));

// The IAM policies that grant an action, and the role (logical ID) each is attached to.
const policiesMentioning = (action: string) =>
	Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes(`"${action}"`));
const rolesOf = (p: ReturnType<typeof policiesMentioning>[number]) => (p.Properties.Roles as { Ref: string }[]).map((r) => r.Ref).join(",");

const routeByKey = (key: string) =>
	Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
		.map((r) => r.Properties)
		.find((r) => r.RouteKey === key);

// Our functions by logical ID; CDK's own custom-resource provider functions are excluded.
const ownFunctions = () => Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) => !id.startsWith("Custom"));
const functionNamed = (re: RegExp) => {
	const matches = ownFunctions().filter(([id]) => re.test(id));
	expect(matches, String(re)).toHaveLength(1);
	return matches[0]!;
};

const BILLING_ROUTES = [
	"GET /v1/orgs/{orgId}/billing",
	"POST /v1/orgs/{orgId}/billing/checkout",
	"POST /v1/orgs/{orgId}/billing/portal",
	"POST /v1/orgs/{orgId}/billing/change",
	"PATCH /v1/orgs/{orgId}/billing",
];

describe("TracewiseStack", () => {
	it("encrypts every table and expires hot data with TTL", () => {
		const tables = template.findResources("AWS::DynamoDB::GlobalTable");
		expect(Object.keys(tables)).toHaveLength(5);
		for (const t of Object.values(tables)) {
			expect(t.Properties.SSESpecification).toMatchObject({ SSEEnabled: true });
			expect(t.Properties.BillingMode).toBe("PAY_PER_REQUEST");
		}
		template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
			KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
			TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true },
		});
	});

	it("dead-letters events after 5 failed attempts, on encrypted queues", () => {
		template.hasResourceProperties("AWS::SQS::Queue", {
			RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
			SqsManagedSseEnabled: true,
		});
	});

	it("consumes in batches with partial-failure reporting and bounded concurrency", () => {
		// Batch 100 with a 1 s window: the load-tested default (docs/experiments.md, experiment 4).
		template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
			BatchSize: 100,
			MaximumBatchingWindowInSeconds: 1,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
			ScalingConfig: { MaximumConcurrency: 10 },
		});
	});

	it("runs every function on Graviton with X-Ray tracing", () => {
		// Our functions only: CDK's own custom-resource provider functions are excluded.
		const fns = ownFunctions().map(([, f]) => f);
		expect(fns).toHaveLength(13);
		for (const f of fns) {
			expect(f.Properties.Architectures).toEqual(["arm64"]);
			expect(f.Properties.TracingConfig).toEqual({ Mode: "Active" });
		}
	});

	it("does not let the ingest function touch the traces table", () => {
		const policies = policiesFor(/Ingest/);
		expect(policies).toHaveLength(1);
		expect(JSON.stringify(policies[0])).not.toMatch(/Traces/);
	});

	it("alarms on dead letters, backlog, ingest errors, failed deletions, global caps, failed eval runs and billing, and emails them", () => {
		template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
		for (const cap of ["orgs", "judge"])
			template.hasResourceProperties("AWS::CloudWatch::Alarm", {
				Namespace: "Tracewise/Limits",
				MetricName: "GlobalCapHit",
				Dimensions: [{ Name: "Cap", Value: cap }],
				Statistic: "Sum",
				Period: 300,
				Threshold: 1,
				ComparisonOperator: "GreaterThanOrEqualToThreshold",
				AlarmActions: [Match.anyValue()],
			});
		template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alerts@example.com" });
	});

	it("alarms when a nightly eval execution fails", () => {
		const [smId] = Object.keys(template.findResources("AWS::StepFunctions::StateMachine"));
		template.hasResourceProperties("AWS::CloudWatch::Alarm", {
			Namespace: "AWS/States",
			MetricName: "ExecutionsFailed",
			Dimensions: [{ Name: "StateMachineArn", Value: { Ref: smId } }],
			Statistic: "Sum",
			Period: 3600,
			Threshold: 1,
			ComparisonOperator: "GreaterThanOrEqualToThreshold",
			EvaluationPeriods: 1,
			TreatMissingData: "notBreaching",
			AlarmActions: [Match.anyValue()],
		});
	});

	it("throttles the API as a backstop", () => {
		template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
			DefaultRouteSettings: { ThrottlingRateLimit: 200, ThrottlingBurstLimit: 400 },
		});
	});

	it("keeps the data lake private, encrypted and TLS-only, with retention", () => {
		template.hasResourceProperties("AWS::S3::Bucket", {
			BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
			PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
			LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: "traces/", ExpirationInDays: 365 })]) },
		});
		template.hasResourceProperties("AWS::S3::BucketPolicy", {
			PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
		});
	});

	it("delivers Parquet, partitioned by tenant and day", () => {
		template.hasResourceProperties("AWS::KinesisFirehose::DeliveryStream", {
			ExtendedS3DestinationConfiguration: Match.objectLike({
				Prefix: "traces/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{partitionKeyFromQuery:dt}/",
				DynamicPartitioningConfiguration: Match.objectLike({ Enabled: true }),
				DataFormatConversionConfiguration: Match.objectLike({
					Enabled: true,
					OutputFormatConfiguration: { Serializer: { ParquetSerDe: { Compression: "SNAPPY" } } },
				}),
			}),
		});
	});

	it("forces every Athena query to name a tenant (injected partition projection)", () => {
		template.hasResourceProperties("AWS::Glue::Table", {
			TableInput: Match.objectLike({
				Parameters: Match.objectLike({ "projection.enabled": "true", "projection.tenant_id.type": "injected" }),
			}),
		});
	});

	it("caps how much any Athena query can scan, and callers can't override it", () => {
		template.hasResourceProperties("AWS::Athena::WorkGroup", {
			WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 1024 ** 3 }),
		});
	});

	it("lets the API-key functions write Accounts only to stamp a key's last_used_at", () => {
		for (const re of [/IngestServiceRole/, /QueryServiceRole/, /SummaryServiceRole/, /EvalsApiServiceRole/]) {
			const statements = policiesFor(re).flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]);
			const accountWrites = statements.filter(
				(st) => /Accounts/.test(JSON.stringify(st.Resource)) && /dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/.test(JSON.stringify(st.Action)),
			);
			expect(accountWrites, String(re)).toEqual([expect.objectContaining({ Action: "dynamodb:UpdateItem", Condition: TOUCH_KEY_CONDITION })]);
		}
	});

	it("gives the analytics function read-only access to data, writing only its query counter", () => {
		const statements = policiesFor(/SummaryServiceRole/).flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]);
		const writes = statements.filter((st) => /dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/.test(JSON.stringify(st.Action)));
		// analytics_queries_per_day is counted in the Quotas table, and an API key's
		// last_used_at is stamped in Accounts. Nothing else.
		expect(writes).toHaveLength(2);
		for (const w of writes) expect(w.Action).toBe("dynamodb:UpdateItem");
		const quota = writes.filter((w) => /Quotas/.test(JSON.stringify(w.Resource)));
		expect(quota).toHaveLength(1);
		expect(JSON.stringify(quota[0]!.Resource)).not.toMatch(/Traces|Accounts|Tenants/);
		const stamp = writes.filter((w) => /Accounts/.test(JSON.stringify(w.Resource)));
		expect(stamp).toHaveLength(1);
		expect(stamp[0]).toMatchObject({ Condition: TOUCH_KEY_CONDITION });
		const doc = JSON.stringify(statements);
		expect(doc).not.toMatch(/glue:(Create|Update|Delete)/);
		expect(doc).not.toMatch(/firehose:/);
	});

	it("runs evaluations nightly as a workflow with throttling retries and per-trace failure handling", () => {
		template.hasResourceProperties("AWS::Scheduler::Schedule", { ScheduleExpression: "cron(0 6 * * ? *)" });
		const [sm] = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
		const definition = JSON.stringify(sm!.Properties.DefinitionString);
		expect(definition).toContain("ThrottlingException");
		expect(definition).toContain("GradeFailed");
		expect(definition).toMatch(/MaxConcurrency\\?":\s*4/);
	});

	it("carries each org's judge budget through the workflow to the record step", () => {
		const [sm] = Object.values(template.findResources("AWS::StepFunctions::StateMachine"));
		const definition = JSON.stringify(sm!.Properties.DefinitionString);
		// Step Functions drops any field an itemSelector or payload doesn't name.
		for (const field of ["sample_budget", "sample_limit"]) {
			expect(definition).toContain(`${field}.$\\":\\"$$.Map.Item.Value.${field}`); // EachTenant itemSelector
			expect(definition).toContain(`${field}.$\\":\\"$.${field}`); // Record payload
		}
		// The per-org results are dropped, so the execution's output stays small however many orgs ran.
		const parts = (sm!.Properties.DefinitionString["Fn::Join"]?.[1] ?? [sm!.Properties.DefinitionString]) as unknown[];
		const states = JSON.parse(parts.map((p) => (typeof p === "string" ? p : "TOKEN")).join("")).States;
		expect(states.EachTenant.ResultPath).toBeNull();
	});

	it("lets the record step read org profiles, so it skips orgs that stopped being active", () => {
		const fns = Object.entries(template.findResources("AWS::Lambda::Function")).filter(([id]) => /EvalRecord/.test(id));
		expect(fns).toHaveLength(1);
		const accountsRef = fns[0]![1].Properties.Environment.Variables.ACCOUNTS_TABLE;
		expect(JSON.stringify(accountsRef)).toMatch(/Accounts/);
		const statements = policiesFor(/EvalRecordServiceRole/).flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]);
		const accounts = statements.filter((st) => /Accounts/.test(JSON.stringify(st.Resource)));
		expect(JSON.stringify(accounts)).toContain("dynamodb:GetItem");
		expect(JSON.stringify(accounts)).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
	});

	it("scopes the judge to one Bedrock model and metrics to one namespace", () => {
		const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
		expect(policies).toContain("inference-profile/us.amazon.nova-pro-v1:0");
		expect(policies).toContain("foundation-model/amazon.nova-pro-v1:0");
		// No wildcard *action* (the region wildcard inside the foundation-model ARN is expected).
		expect(policies).not.toContain('"bedrock:*"');
		template.hasResourceProperties("AWS::IAM::Policy", {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({ Action: "cloudwatch:PutMetricData", Condition: { StringEquals: { "cloudwatch:namespace": "Tracewise/Evals" } } }),
				]),
			},
		});
	});

	it("serves the dashboard privately through CloudFront with strict security headers", () => {
		template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", Match.anyValue());
		template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
			ResponseHeadersPolicyConfig: Match.objectLike({
				SecurityHeadersConfig: Match.objectLike({
					ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.stringLikeRegexp("script-src 'self';") }),
					FrameOptions: Match.objectLike({ FrameOption: "DENY" }),
				}),
			}),
		});
	});

	it("routes /v1/* through CloudFront with a short, per-key cache", () => {
		template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
			CachePolicyConfig: Match.objectLike({
				DefaultTTL: 60,
				ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
					HeadersConfig: { HeaderBehavior: "whitelist", Headers: ["authorization"] },
				}),
			}),
		});
	});

	it("never caches console API calls, and checks them before the cached /v1/* behaviour", () => {
		const [dist] = Object.values(template.findResources("AWS::CloudFront::Distribution"));
		const behaviors = dist!.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string; CachePolicyId: unknown; ViewerProtocolPolicy: string }[];
		expect(behaviors.map((b) => b.PathPattern)).toEqual(["/v1/orgs*", "/v1/invites/*", "/v1/*", "/console/*"]);
		expect(behaviors[0]!.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // managed CachingDisabled
		expect(behaviors[1]!.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
		expect(behaviors[2]!.ViewerProtocolPolicy).toBe("https-only");
	});

	it("lets only the console talk to Cognito, and keeps scripts first-party", () => {
		const csps = Object.values(template.findResources("AWS::CloudFront::ResponseHeadersPolicy")).map((p) => JSON.stringify(p.Properties));
		expect(csps).toHaveLength(2);
		expect(csps.filter((c) => c.includes("amazoncognito.com"))).toHaveLength(1);
		for (const c of csps) expect(c).toContain("script-src 'self';");
	});

	it("protects every console and session route with the Cognito JWT authorizer, and no key route", () => {
		const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map((r) => r.Properties);
		const jwt = [...CONSOLE_ROUTES, ...Object.values(JWT_DATA_ROUTES)];
		for (const key of jwt) expect(routes.find((r) => r.RouteKey === key)).toMatchObject({ AuthorizationType: "JWT" });
		for (const key of ["POST /v1/traces", "GET /v1/traces", "GET /v1/analytics/summary", "GET /v1/evals", "GET /v1/me"])
			expect(routes.find((r) => r.RouteKey === key)?.AuthorizationType ?? "NONE").toBe("NONE");
		template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", { AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"] });
	});

	it("signs users in with verified email, optional TOTP and no SMS", () => {
		template.hasResourceProperties("AWS::Cognito::UserPool", {
			AutoVerifiedAttributes: ["email"],
			UsernameAttributes: ["email"],
			MfaConfiguration: "OPTIONAL",
			EnabledMfas: ["SOFTWARE_TOKEN_MFA"],
		});
		template.hasResourceProperties("AWS::Cognito::UserPoolClient", { GenerateSecret: false, AllowedOAuthFlows: ["code"], RefreshTokenRotation: { Feature: "ENABLED" } });
	});

	it("only creates the password-auth smoke client when asked", () => {
		const smokeClients = (t: Template) =>
			Object.values(t.findResources("AWS::Cognito::UserPoolClient")).filter((c) =>
				(c.Properties.ExplicitAuthFlows ?? []).includes("ALLOW_ADMIN_USER_PASSWORD_AUTH"),
			);
		expect(smokeClients(template)).toHaveLength(0);
		const withSmoke = Template.fromStack(new TracewiseStack(new App(), "Smoke", { smokeClient: true }));
		expect(smokeClients(withSmoke)).toHaveLength(1);
	}, 120_000);

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

	it("deletes orgs from an encrypted queue that dead-letters and alarms after 5 attempts", () => {
		// 6x the deleter's 60 s timeout.
		template.hasResourceProperties("AWS::SQS::Queue", {
			VisibilityTimeout: 360,
			SqsManagedSseEnabled: true,
			RedrivePolicy: { maxReceiveCount: 5, deadLetterTargetArn: Match.anyValue() },
		});
		template.hasResourceProperties("AWS::Lambda::EventSourceMapping", { BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"] });
		template.hasResourceProperties("AWS::Lambda::Function", { Timeout: 60, Environment: { Variables: Match.objectLike({ LAKE_BUCKET: Match.anyValue(), DELETION_QUEUE_URL: Match.anyValue() }) } });
	});
	describe("billing", () => {
		it("leaves the Stripe webhook public and puts every billing route behind the JWT authorizer", () => {
			const webhook = routeByKey("POST /v1/stripe/webhook");
			expect(webhook).toBeDefined();
			expect(webhook?.AuthorizationType ?? "NONE").toBe("NONE");
			// Stripe signs the body; the handler verifies that instead of a token.
			expect(JSON.stringify(template.findResources("AWS::ApiGatewayV2::Integration"))).toMatch(/BillingWebhook/);
			expect(CONSOLE_ROUTES).toHaveLength(21);
			for (const k of BILLING_ROUTES) {
				expect(CONSOLE_ROUTES as readonly string[]).toContain(k);
				expect(routeByKey(k), k).toMatchObject({ AuthorizationType: "JWT" });
			}
		});

		it("keeps the Stripe keys in a retained secret, created with placeholders", () => {
			const secrets = template.findResources("AWS::SecretsManager::Secret");
			expect(Object.keys(secrets)).toHaveLength(1);
			const [secret] = Object.values(secrets);
			expect(secret!.Properties.Name).toBe("tracewise/stripe");
			// A redeploy or a stack deletion must never take the keys an operator put in.
			expect(secret!.DeletionPolicy).toBe("Retain");
			expect(secret!.UpdateReplacePolicy).toBe("Retain");
			expect(JSON.parse(secret!.Properties.GenerateSecretString.SecretStringTemplate)).toEqual({ secret_key: "replace-me", webhook_secret: "replace-me" });
			expect(secret!.Properties.SecretString).toBeUndefined();
		});

		it("lets only the billing and console functions read the Stripe secret", () => {
			const readers = policiesMentioning("secretsmanager:GetSecretValue").map(rolesOf);
			expect(readers.sort()).toEqual([expect.stringMatching(/BillingMeter/), expect.stringMatching(/BillingWebhook/), expect.stringMatching(/ConsoleFn/)]);
			// The data plane, the deleter and every eval step (the regexes must each find a role, or this proves nothing).
			for (const r of [/Ingest/, /Processor/, /Query/, /Summary/, /EvalsApi/, /DeleterFn/, /Eval(?!sApi)/]) {
				expect(policiesFor(r).length, String(r)).toBeGreaterThan(0);
				expect(JSON.stringify(policiesFor(r)), String(r)).not.toContain("secretsmanager");
			}
			// The ARN, never the key: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are for operator scripts.
			for (const [id, f] of ownFunctions()) {
				const vars = Object.keys(f.Properties.Environment?.Variables ?? {});
				expect(vars, id).not.toContain("STRIPE_SECRET_KEY");
				expect(vars, id).not.toContain("STRIPE_WEBHOOK_SECRET");
				expect(vars.includes("STRIPE_SECRET_ARN"), id).toBe(/BillingMeter|BillingWebhook|ConsoleFn/.test(id));
			}
		});

		it("gives the billing functions Accounts read/write and Quotas read only", () => {
			for (const re of [/BillingWebhook/, /BillingMeter/]) {
				const [, f] = functionNamed(new RegExp(`^${re.source}[A-F0-9]{8}$`));
				expect(Object.keys(f.Properties.Environment.Variables), String(re)).toEqual(expect.arrayContaining(["ACCOUNTS_TABLE", "QUOTAS_TABLE", "STRIPE_SECRET_ARN"]));
				const statements = policiesFor(new RegExp(`${re.source}ServiceRole`)).flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]);
				const on = (table: string) => JSON.stringify(statements.filter((st) => new RegExp(table).test(JSON.stringify(st.Resource))).map((st) => st.Action));
				expect(on("Accounts"), String(re)).toMatch(/dynamodb:UpdateItem/);
				expect(on("Quotas"), String(re)).toMatch(/dynamodb:GetItem/);
				expect(on("Quotas"), String(re)).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
				expect(JSON.stringify(statements), String(re)).not.toMatch(/Traces|Tenants|Lake|EvalsRuns/);
			}
			// Only the meter publishes metrics, and only to its own namespace.
			const metricStatements = (re: RegExp) =>
				policiesFor(re)
					.flatMap((p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Condition?: unknown }[])
					.filter((st) => JSON.stringify(st.Action).includes("cloudwatch:PutMetricData"));
			expect(metricStatements(/BillingMeterServiceRole/)).toEqual([
				expect.objectContaining({ Condition: { StringEquals: { "cloudwatch:namespace": "Tracewise/Billing" } } }),
			]);
			expect(metricStatements(/BillingWebhookServiceRole/)).toEqual([]);
		});

		it("gives the webhook time to outlast its Stripe calls but not its event lease", () => {
			const [, webhook] = functionNamed(/^BillingWebhook[A-F0-9]{8}$/);
			// Each Stripe call can take ~30 s with retries; the event lease (LEASE_SECONDS) is 90 s.
			expect(webhook.Properties.Timeout).toBe(60);
			expect(webhook.Properties.Timeout).toBeLessThan(90);
			const [, meter] = functionNamed(/^BillingMeter[A-F0-9]{8}$/);
			expect(meter.Properties.Timeout).toBe(300);
		});

		it("reports usage hourly and alarms when metering stalls or fails", () => {
			template.resourceCountIs("AWS::Scheduler::Schedule", 2);
			const [meterId] = functionNamed(/^BillingMeter[A-F0-9]{8}$/);
			template.hasResourceProperties("AWS::Scheduler::Schedule", {
				ScheduleExpression: "rate(1 hour)",
				Target: Match.objectLike({ Arn: { "Fn::GetAtt": [meterId, "Arn"] } }),
			});
			const [webhookId] = functionNamed(/^BillingWebhook[A-F0-9]{8}$/);
			const errorsAlarm = (fnId: string, period: number) =>
				template.hasResourceProperties("AWS::CloudWatch::Alarm", {
					Namespace: "AWS/Lambda",
					MetricName: "Errors",
					Dimensions: [{ Name: "FunctionName", Value: { Ref: fnId } }],
					Period: period,
					Threshold: 1,
					ComparisonOperator: "GreaterThanOrEqualToThreshold",
					EvaluationPeriods: 1,
					AlarmActions: [Match.anyValue()],
				});
			errorsAlarm(webhookId, 300);
			errorsAlarm(meterId, 3600);
			// The meter publishes this datapoint only after a fully successful run, so its absence for 3 hours fires.
			template.hasResourceProperties("AWS::CloudWatch::Alarm", {
				Namespace: "Tracewise/Billing",
				MetricName: "MeterLastSuccessAgeMinutes",
				Statistic: "SampleCount",
				Period: 10800,
				EvaluationPeriods: 1,
				Threshold: 1,
				ComparisonOperator: "LessThanThreshold",
				TreatMissingData: "breaching",
				AlarmActions: [Match.anyValue()],
			});
			const ids = Object.keys(template.findResources("AWS::CloudWatch::Alarm"));
			for (const name of ["BillingWebhookErrors", "BillingMeterErrors", "BillingMeterStale"]) expect(ids.some((id) => id.includes(name)), name).toBe(true);
		});

		it("outputs the secret's ARN and the URL to register with Stripe", () => {
			const outputs = template.findOutputs("*");
			expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["StripeSecretArn", "StripeWebhookUrl"]));
			expect(JSON.stringify(outputs.StripeWebhookUrl!.Value)).toContain("/v1/stripe/webhook");
		});

		it("covers the longest plan retention in the deleter", () => {
			expect(Math.max(...Object.values(PLANS).map((p) => p.retention_days))).toBeLessThanOrEqual(MAX_RETENTION_DAYS);
		});
	});
});
