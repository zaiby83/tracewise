import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { Analytics } from "./analytics";
import { Evals } from "./evals";

const services = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../services");

export interface TracewiseStackProps extends StackProps {
	// Where alarms are emailed. Omit to create the topic without a subscription.
	alarmEmail?: string;
	// How long the SQS trigger waits to fill a batch, and the batch size. Together they
	// trade freshness for fewer, larger invocations; see docs/experiments.md. AWS
	// requires a window above 0 for batches larger than 10.
	batchingWindowSeconds?: number;
	batchSize?: number;
	// Bedrock model (or cross-region inference profile) that grades sampled traces.
	judgeModel?: string;
}

export class TracewiseStack extends Stack {
	constructor(scope: Construct, id: string, props: TracewiseStackProps = {}) {
		super(scope, id, props);

		// ---- Storage --------------------------------------------------------------
		// On-demand billing: zero cost when idle, no capacity planning for bursts.
		const traces = new TableV2(this, "Traces", {
			partitionKey: { name: "pk", type: AttributeType.STRING },
			sortKey: { name: "sk", type: AttributeType.STRING },
			billing: Billing.onDemand(),
			timeToLiveAttribute: "expires_at",
			encryption: TableEncryptionV2.awsManagedKey(),
			removalPolicy: RemovalPolicy.DESTROY, // demo project: `cdk destroy` cleans up fully
		});

		const tenants = new TableV2(this, "Tenants", {
			partitionKey: { name: "key_hash", type: AttributeType.STRING },
			billing: Billing.onDemand(),
			encryption: TableEncryptionV2.awsManagedKey(),
			removalPolicy: RemovalPolicy.DESTROY,
		});

		const quotas = new TableV2(this, "Quotas", {
			partitionKey: { name: "window", type: AttributeType.STRING },
			billing: Billing.onDemand(),
			timeToLiveAttribute: "expires_at",
			encryption: TableEncryptionV2.awsManagedKey(),
			removalPolicy: RemovalPolicy.DESTROY,
		});

		// ---- Queue ------------------------------------------------------------------
		const processorTimeout = Duration.seconds(30);
		const dlq = new Queue(this, "IngestDLQ", {
			retentionPeriod: Duration.days(14),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
		});
		const queue = new Queue(this, "IngestQueue", {
			// AWS guidance: at least 6x the consumer's timeout, so in-flight retries don't
			// make a message visible again while it's still being processed.
			visibilityTimeout: processorTimeout.plus(Duration.seconds(150)),
			retentionPeriod: Duration.days(4),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
			deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
		});

		// ---- Functions --------------------------------------------------------------
		const fn = (name: string, entry: string, extra: Partial<NodejsFunctionProps> = {}) =>
			new NodejsFunction(this, name, {
				entry: path.join(services, entry),
				runtime: Runtime.NODEJS_22_X,
				architecture: Architecture.ARM_64, // Graviton: ~20% cheaper per GB-second
				memorySize: 512,
				tracing: Tracing.ACTIVE,
				logGroup: new LogGroup(this, `${name}Logs`, {
					retention: RetentionDays.TWO_WEEKS,
					removalPolicy: RemovalPolicy.DESTROY,
				}),
				bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: "node22" },
				environment: { NODE_OPTIONS: "--enable-source-maps" },
				...extra,
			});

		const ingest = fn("Ingest", "ingest/handler.ts", { timeout: Duration.seconds(10) });
		ingest.addEnvironment("QUEUE_URL", queue.queueUrl);
		ingest.addEnvironment("TENANTS_TABLE", tenants.tableName);
		ingest.addEnvironment("QUOTAS_TABLE", quotas.tableName);
		// Least privilege: ingest can enqueue, read tenants and update quota counters. It
		// cannot read or write traces.
		queue.grantSendMessages(ingest);
		tenants.grantReadData(ingest);
		quotas.grantReadWriteData(ingest);

		const analytics = new Analytics(this, "Analytics");

		const processor = fn("Processor", "processor/handler.ts", { timeout: processorTimeout });
		processor.addEnvironment("TRACES_TABLE", traces.tableName);
		processor.addEnvironment("DELIVERY_STREAM", analytics.deliveryStream.ref);
		traces.grantWriteData(processor);
		analytics.grantPut(processor);
		processor.addEventSource(
			new SqsEventSource(queue, {
				batchSize: props.batchSize ?? 10,
				maxBatchingWindow: Duration.seconds(props.batchingWindowSeconds ?? 0),
				reportBatchItemFailures: true,
				// Caps how hard the consumer pushes on DynamoDB; the queue absorbs the rest.
				maxConcurrency: 10,
			}),
		);

		const query = fn("Query", "query/handler.ts", { timeout: Duration.seconds(10) });
		query.addEnvironment("TRACES_TABLE", traces.tableName);
		query.addEnvironment("TENANTS_TABLE", tenants.tableName);
		traces.grantReadData(query);
		tenants.grantReadData(query);

		const summary = fn("Summary", "analytics/handler.ts", { timeout: Duration.seconds(29) });
		summary.addEnvironment("TENANTS_TABLE", tenants.tableName);
		summary.addEnvironment("WORKGROUP", analytics.workGroup.name);
		summary.addEnvironment("GLUE_DATABASE", analytics.database);
		tenants.grantReadData(summary);
		analytics.grantQuery(summary);

		// ---- Evaluations ------------------------------------------------------------
		const alarms = new Topic(this, "Alarms");
		if (props.alarmEmail) alarms.addSubscription(new EmailSubscription(props.alarmEmail));

		const evals = new Evals(this, "Evals", {
			traces,
			tenants,
			alerts: alarms,
			fn,
			judgeModel: props.judgeModel ?? "us.amazon.nova-pro-v1:0", // chosen by calibration: docs/experiments.md
		});
		const evalsApi = fn("EvalsApi", "evals/api.ts", { timeout: Duration.seconds(10) });
		evalsApi.addEnvironment("TENANTS_TABLE", tenants.tableName);
		evalsApi.addEnvironment("EVALS_TABLE", evals.table.tableName);
		tenants.grantReadData(evalsApi);
		evals.table.grantReadData(evalsApi);

		// ---- API --------------------------------------------------------------------
		const api = new HttpApi(this, "Api", { description: "Tracewise ingest and query API" });
		api.addRoutes({ path: "/v1/traces", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("IngestRoute", ingest) });
		api.addRoutes({ path: "/v1/traces", methods: [HttpMethod.GET], integration: new HttpLambdaIntegration("QueryRoute", query) });
		api.addRoutes({
			path: "/v1/analytics/summary",
			methods: [HttpMethod.GET],
			integration: new HttpLambdaIntegration("AnalyticsRoute", summary),
		});
		api.addRoutes({ path: "/v1/evals", methods: [HttpMethod.GET], integration: new HttpLambdaIntegration("EvalsRoute", evalsApi) });
		// Account-wide backstop throttle; per-tenant quotas are enforced in the ingest function.
		const stage = api.defaultStage!.node.defaultChild as import("aws-cdk-lib/aws-apigatewayv2").CfnStage;
		stage.defaultRouteSettings = { throttlingRateLimit: 200, throttlingBurstLimit: 400 };

		// ---- Alarms -----------------------------------------------------------------
		const notify = new SnsAction(alarms);

		new Alarm(this, "DeadLetters", {
			alarmDescription: "Events failed processing 5 times and were dead-lettered",
			metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
			threshold: 0,
			comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		new Alarm(this, "QueueBacklog", {
			alarmDescription: "Oldest queued event is over 5 minutes old: processing is falling behind",
			metric: queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
			threshold: 300,
			evaluationPeriods: 3,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		new Alarm(this, "IngestErrors", {
			alarmDescription: "Ingest function is throwing errors",
			metric: ingest.metricErrors({ period: Duration.minutes(1) }),
			threshold: 5,
			evaluationPeriods: 2,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
		new CfnOutput(this, "TenantsTable", { value: tenants.tableName });
		new CfnOutput(this, "TracesTable", { value: traces.tableName });
		new CfnOutput(this, "LakeBucket", { value: analytics.bucket.bucketName });
		new CfnOutput(this, "EvalWorkflow", { value: evals.stateMachine.stateMachineArn });
	}
}
