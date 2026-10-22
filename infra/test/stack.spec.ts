import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, JWT_DATA_ROUTES } from "../../services/console/route-keys";
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
		const fns = Object.entries(template.findResources("AWS::Lambda::Function"))
			.filter(([id]) => !id.startsWith("Custom"))
			.map(([, f]) => f);
		expect(fns).toHaveLength(11);
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

	it("alarms on dead letters, backlog, ingest errors, failed deletions, global caps and failed eval runs, and emails them", () => {
		template.resourceCountIs("AWS::CloudWatch::Alarm", 7);
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
});
