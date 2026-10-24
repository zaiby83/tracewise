import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, Stats, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat, type NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { Accounts } from "./accounts";
import { Analytics } from "./analytics";
// Aliased: Billing is also DynamoDB's billing-mode class, used for the tables above.
import { Billing as StripeBilling } from "./billing";
import { Dashboard } from "./dashboard";
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
	// Maximum concurrent processor invocations. Bounded by the account's Lambda limit.
	processorConcurrency?: number;
	// Lets owners buy paid plans (Checkout and plan changes). Off by default, so a stack running on test
	// keys, or one not ready to take payments, never sends anyone to Checkout.
	billingCheckout?: boolean;
	// Bedrock model (or cross-region inference profile) that grades sampled traces.
	judgeModel?: string;
	// Read-only key the public dashboard uses to show the demo tenant.
	dashboardKey?: string;
	// Prefix of the Cognito managed login domain; must be unique within the region.
	authDomainPrefix?: string;
	// Adds a password-auth app client for the self-serve smoke test.
	smokeClient?: boolean;
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

		// Orgs, members, invites and keys, in one table (see the self-serve design, §3.1).
		const accountsTable = new TableV2(this, "Accounts", {
			partitionKey: { name: "pk", type: AttributeType.STRING },
			sortKey: { name: "sk", type: AttributeType.STRING },
			billing: Billing.onDemand(),
			timeToLiveAttribute: "expires_at", // invites
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

		// Every function that accepts an API key stamps the key's last_used_at (touchKey). The
		// condition limits that UpdateItem to the key attributes and last_used_at, so none of
		// them can change a profile, member or key otherwise.
		const grantTouchKey = (f: NodejsFunction) =>
			f.addToRolePolicy(
				new PolicyStatement({
					actions: ["dynamodb:UpdateItem"],
					resources: [accountsTable.tableArn],
					conditions: { "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "last_used_at"] } },
				}),
			);

		const ingest = fn("Ingest", "ingest/handler.ts", { timeout: Duration.seconds(10) });
		ingest.addEnvironment("QUEUE_URL", queue.queueUrl);
		ingest.addEnvironment("TENANTS_TABLE", tenants.tableName);
		ingest.addEnvironment("QUOTAS_TABLE", quotas.tableName);
		ingest.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		// Least privilege: ingest can enqueue, read tenants and update quota counters. It
		// cannot read or write traces. It reads keys and org profiles from Accounts, and
		// writes there only to stamp a key's last_used_at.
		queue.grantSendMessages(ingest);
		tenants.grantReadData(ingest);
		quotas.grantReadWriteData(ingest);
		accountsTable.grantReadData(ingest);
		grantTouchKey(ingest);

		const analytics = new Analytics(this, "Analytics");

		const processor = fn("Processor", "processor/handler.ts", { timeout: processorTimeout });
		processor.addEnvironment("TRACES_TABLE", traces.tableName);
		processor.addEnvironment("DELIVERY_STREAM", analytics.deliveryStream.ref);
		traces.grantWriteData(processor);
		analytics.grantPut(processor);
		processor.addEventSource(
			new SqsEventSource(queue, {
				batchSize: props.batchSize ?? 100,
				maxBatchingWindow: Duration.seconds(props.batchingWindowSeconds ?? 1),
				reportBatchItemFailures: true,
				// Caps how hard the consumer pushes on DynamoDB; the queue absorbs the rest.
				// Defaults (batch 100, 1 s window, 10 concurrent) come from load testing at a
				// 10-execution account limit: see docs/experiments.md, experiment 4.
				maxConcurrency: props.processorConcurrency ?? 10,
			}),
		);

		const query = fn("Query", "query/handler.ts", { timeout: Duration.seconds(10) });
		query.addEnvironment("TRACES_TABLE", traces.tableName);
		query.addEnvironment("TENANTS_TABLE", tenants.tableName);
		query.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		traces.grantReadData(query);
		tenants.grantReadData(query);
		accountsTable.grantReadData(query); // membership checks and org profiles
		grantTouchKey(query);

		const summary = fn("Summary", "analytics/handler.ts", { timeout: Duration.seconds(29) });
		summary.addEnvironment("TENANTS_TABLE", tenants.tableName);
		summary.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		summary.addEnvironment("QUOTAS_TABLE", quotas.tableName);
		summary.addEnvironment("WORKGROUP", analytics.workGroup.name);
		summary.addEnvironment("GLUE_DATABASE", analytics.database);
		tenants.grantReadData(summary);
		accountsTable.grantReadData(summary);
		grantTouchKey(summary);
		// The only write: the per-org daily query counter (analytics_queries_per_day).
		quotas.grant(summary, "dynamodb:UpdateItem");
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
		evalsApi.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		tenants.grantReadData(evalsApi);
		evals.table.grantReadData(evalsApi);
		accountsTable.grantReadData(evalsApi);
		grantTouchKey(evalsApi);
		// The workflow lists orgs from their profiles (legacy key rows too, until migrated),
		// and the sample step loads each org's rubric and records the night's sample count,
		// which the console's usage route reads. Sample and record both re-check the org is
		// still active, since a deletion can start while the run is under way.
		evals.listFn.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		accountsTable.grantReadData(evals.listFn);
		evals.recordFn.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		accountsTable.grantReadData(evals.recordFn);
		evals.sampleFn.addEnvironment("ACCOUNTS_TABLE", accountsTable.tableName);
		evals.sampleFn.addEnvironment("QUOTAS_TABLE", quotas.tableName);
		accountsTable.grantReadData(evals.sampleFn);
		quotas.grant(evals.sampleFn, "dynamodb:PutItem");

		// ---- Accounts ---------------------------------------------------------------
		const accounts = new Accounts(this, "SelfServe", {
			fn,
			accounts: accountsTable,
			keyIndex: tenants,
			quotas,
			traces,
			evalRuns: evals.table,
			lake: analytics.bucket,
			alerts: alarms,
			authDomainPrefix: props.authDomainPrefix ?? `tracewise-${Aws.ACCOUNT_ID}`,
			smokeClient: props.smokeClient ?? false,
		});

		// ---- Billing ----------------------------------------------------------------
		const billing = new StripeBilling(this, "Billing", {
			fn,
			accounts: accountsTable,
			quotas,
			alerts: alarms,
			consoleFn: accounts.consoleFn,
			checkoutEnabled: props.billingCheckout ?? false,
		});

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
		api.addRoutes({ path: "/v1/me", methods: [HttpMethod.GET], integration: new HttpLambdaIntegration("MeRoute", query) });
		// No authorizer: Stripe calls this directly, and the handler verifies Stripe's signature
		// over the raw body instead. The billing console routes are JWT, via CONSOLE_ROUTES.
		api.addRoutes({
			path: "/v1/stripe/webhook",
			methods: [HttpMethod.POST],
			integration: new HttpLambdaIntegration("StripeWebhookRoute", billing.webhookFn),
		});

		const dashboard = new Dashboard(this, "Dashboard", { api, authDomainUrl: accounts.authDomainUrl });
		const { clientId, smokeClientId } = accounts.connect(api, `https://${dashboard.distribution.distributionDomainName}`, { query, summary, evalsApi });
		dashboard.deploy({ demoKey: props.dashboardKey ?? "", auth: { domain: accounts.authDomainUrl, clientId } });
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

		// The nightly run is otherwise silent: a failed execution means no org was evaluated.
		// An hourly period alerts within the hour of the 06:00 UTC run.
		new Alarm(this, "EvalWorkflowFailed", {
			alarmDescription: "The nightly evaluation workflow failed: orgs weren't evaluated",
			metric: evals.stateMachine.metricFailed({ period: Duration.hours(1), statistic: Stats.SUM }),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
		new CfnOutput(this, "TenantsTable", { value: tenants.tableName });
		new CfnOutput(this, "TracesTable", { value: traces.tableName });
		new CfnOutput(this, "LakeBucket", { value: analytics.bucket.bucketName });
		new CfnOutput(this, "EvalWorkflow", { value: evals.stateMachine.stateMachineArn });
		new CfnOutput(this, "DashboardUrl", { value: `https://${dashboard.distribution.distributionDomainName}` });
		new CfnOutput(this, "UserPoolId", { value: accounts.userPool.userPoolId });
		new CfnOutput(this, "ConsoleClientId", { value: clientId });
		if (smokeClientId) new CfnOutput(this, "SmokeClientId", { value: smokeClientId });
		new CfnOutput(this, "AccountsTable", { value: accountsTable.tableName });
		// smoke-billing reads the period counter the meter reports from.
		new CfnOutput(this, "QuotasTable", { value: quotas.tableName });
		new CfnOutput(this, "DeletionQueue", { value: accounts.deletionQueue.queueUrl });
		new CfnOutput(this, "StripeSecretArn", { value: billing.secret.secretArn });
		// Register this endpoint with Stripe (the API Gateway URL, not CloudFront).
		new CfnOutput(this, "StripeWebhookUrl", { value: `${api.apiEndpoint}/v1/stripe/webhook` });
	}
}
