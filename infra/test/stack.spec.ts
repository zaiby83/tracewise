import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { TracewiseStack } from "../lib/tracewise-stack";

// Assertions on the synthesized CloudFormation: the guarantees the design doc makes
// about security and reliability, checked on every change.
let template: Template;
beforeAll(() => {
	const app = new App();
	template = Template.fromStack(new TracewiseStack(app, "Test", { alarmEmail: "alerts@example.com" }));
}, 120_000);

describe("TracewiseStack", () => {
	it("encrypts every table and expires hot data with TTL", () => {
		const tables = template.findResources("AWS::DynamoDB::GlobalTable");
		expect(Object.keys(tables)).toHaveLength(4);
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
		// Small batches, no window: measured ~100x fresher than 100 / 2 s (docs/experiments.md).
		template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
			BatchSize: 10,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
			ScalingConfig: { MaximumConcurrency: 10 },
		});
	});

	it("runs every function on Graviton with X-Ray tracing", () => {
		// Our functions only: CDK's own custom-resource provider functions are excluded.
		const fns = Object.entries(template.findResources("AWS::Lambda::Function"))
			.filter(([id]) => !id.startsWith("Custom"))
			.map(([, f]) => f);
		expect(fns).toHaveLength(9);
		for (const f of fns) {
			expect(f.Properties.Architectures).toEqual(["arm64"]);
			expect(f.Properties.TracingConfig).toEqual({ Mode: "Active" });
		}
	});

	it("does not let the ingest function touch the traces table", () => {
		const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => /Ingest/.test(JSON.stringify(p.Properties.Roles)));
		expect(policies).toHaveLength(1);
		expect(JSON.stringify(policies[0])).not.toMatch(/Traces/);
	});

	it("alarms on dead letters, backlog and ingest errors, and emails them", () => {
		template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
		template.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alerts@example.com" });
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

	it("gives the analytics function read-only access to data", () => {
		const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) => /SummaryServiceRole/.test(JSON.stringify(p.Properties.Roles)));
		const doc = JSON.stringify(policies);
		expect(doc).not.toMatch(/dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)/);
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
});
