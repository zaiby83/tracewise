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
		expect(Object.keys(tables)).toHaveLength(3);
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
		template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
			BatchSize: 100,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
			ScalingConfig: { MaximumConcurrency: 10 },
		});
	});

	it("runs every function on Graviton with X-Ray tracing", () => {
		const fns = Object.values(template.findResources("AWS::Lambda::Function")).filter((f) => f.Properties.Runtime?.startsWith("nodejs"));
		expect(fns.length).toBeGreaterThanOrEqual(3);
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
});
