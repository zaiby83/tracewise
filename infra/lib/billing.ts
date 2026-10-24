import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, Stats, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

// The lines services/billing/webhook.ts logs whenever it answers Stripe with a 500 (no secret to
// verify with, or an event that failed). The stack spec checks the handler still logs exactly these.
export const WEBHOOK_FAILURE_MESSAGES = ["stripe webhook could not be verified", "stripe event failed"] as const;
// The line it logs when a delivery fails the signature check (after one re-read of the secret).
export const WEBHOOK_SIGNATURE_REJECTED = "stripe webhook signature rejected";

export interface BillingProps {
	// Builds a Lambda the same way the rest of the stack does.
	fn: (name: string, entry: string, extra?: Partial<NodejsFunctionProps>) => NodejsFunction;
	accounts: ITableV2;
	quotas: ITableV2;
	alerts: ITopic;
	// The console's billing routes call Stripe too (Checkout, Customer Portal, plan changes).
	// A NodejsFunction rather than IFunction, because it gets STRIPE_SECRET_ARN added.
	consoleFn: NodejsFunction;
}

// Stripe Billing: the secret holding the Stripe keys, the webhook that applies subscription
// changes, and the hourly meter that reports each paid org's events. The webhook's public
// route is added by the stack, next to the other routes.
export class Billing extends Construct {
	readonly secret: Secret;
	readonly webhookFn: NodejsFunction;
	readonly meterFn: NodejsFunction;

	constructor(scope: Construct, id: string, props: BillingProps) {
		super(scope, id);

		// ---- Secret ---------------------------------------------------------------
		// Created with placeholders; operators put the real keys in (see the README). CloudFormation
		// regenerates the value only if GenerateSecretString itself changes, and RETAIN keeps the
		// secret through a stack deletion, so the real keys are never wiped by CDK. CDK names it: a
		// fixed name would make a redeploy after `cdk destroy` fail on the retained secret. Scripts
		// and operators find it through the StripeSecretArn output.
		this.secret = new Secret(this, "StripeSecret", {
			description: "Stripe secret_key and webhook_secret for the billing and console functions",
			generateSecretString: {
				secretStringTemplate: JSON.stringify({ secret_key: "replace-me", webhook_secret: "replace-me" }),
				// Required alongside a template; the loader ignores fields it doesn't know.
				generateStringKey: "placeholder",
				excludePunctuation: true,
			},
			removalPolicy: RemovalPolicy.RETAIN,
		});

		// ---- Functions ------------------------------------------------------------
		// Each Stripe call can take ~30 s with the SDK's retries. The webhook's event lease
		// (LEASE_SECONDS, 90 s, in services/billing/subscriptions.ts) must outlast the whole
		// invocation, or a Stripe retry could run the same event concurrently.
		// Outliving API Gateway's 30 s response cap is deliberate: Stripe may see a 503 and retry, and the 90 s lease plus idempotent handling make that safe.
		this.webhookFn = props.fn("BillingWebhook", "billing/webhook.ts", { timeout: Duration.seconds(60) });
		// One run reports every paid org, five at a time.
		this.meterFn = props.fn("BillingMeter", "billing/meter-handler.ts", { timeout: Duration.minutes(5) });

		// Least privilege: both read and write Accounts (BILLING, customer links, webhook event
		// leases, meter claims) and read Quotas only for the period's event counter. Neither
		// touches traces, keys or the lake. Only these two and the console get the secret.
		for (const f of [this.webhookFn, this.meterFn]) {
			f.addEnvironment("ACCOUNTS_TABLE", props.accounts.tableName);
			f.addEnvironment("QUOTAS_TABLE", props.quotas.tableName);
			f.addEnvironment("STRIPE_SECRET_ARN", this.secret.secretArn);
			props.accounts.grantReadWriteData(f);
			props.quotas.grantReadData(f);
			this.secret.grantRead(f);
		}
		this.meterFn.addToRolePolicy(
			new PolicyStatement({
				actions: ["cloudwatch:PutMetricData"],
				resources: ["*"], // PutMetricData has no resource-level permissions...
				conditions: { StringEquals: { "cloudwatch:namespace": "Tracewise/Billing" } }, // ...so scope by namespace
			}),
		);
		props.consoleFn.addEnvironment("STRIPE_SECRET_ARN", this.secret.secretArn);
		this.secret.grantRead(props.consoleFn);

		// Hourly keeps each org's Stripe usage at most an hour behind; Stripe bills it at period end.
		new Schedule(this, "Hourly", {
			schedule: ScheduleExpression.rate(Duration.hours(1)),
			target: new LambdaInvoke(this.meterFn),
			description: "Reports paid orgs' event usage to Stripe",
		});

		// ---- Alarms ---------------------------------------------------------------
		const notify = new SnsAction(props.alerts);

		new Alarm(this, "BillingWebhookErrors", {
			alarmDescription: "The Stripe webhook function is failing: subscription changes may not be applied",
			metric: this.webhookFn.metricErrors({ period: Duration.minutes(5), statistic: Stats.SUM }),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		// The handler catches its own failures and answers 500 so Stripe retries, so Errors above never
		// sees them. Its error log lines do.
		const webhookFailures = new MetricFilter(this, "WebhookFailureFilter", {
			logGroup: this.webhookFn.logGroup,
			// Lambda's default Text log format prefixes each line with the timestamp, request id and
			// level, so JSON selectors never match. Quoted phrases (CDK adds the quotes) match anywhere.
			filterPattern: FilterPattern.anyTerm(...WEBHOOK_FAILURE_MESSAGES),
			metricNamespace: "Tracewise/Billing",
			metricName: "WebhookFailures",
			metricValue: "1",
		});
		new Alarm(this, "BillingWebhookFailures", {
			alarmDescription: "Stripe webhook events are failing (answered 500): subscription changes aren't being applied",
			metric: webhookFailures.metric({ period: Duration.minutes(5), statistic: Stats.SUM }),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		// A wrong webhook_secret answers every real delivery 400, which Errors and the filter above never
		// see. A few rejections in 15 minutes is that, or someone probing the public URL; either is worth a look.
		const signatureRejected = new MetricFilter(this, "WebhookSignatureFilter", {
			logGroup: this.webhookFn.logGroup,
			filterPattern: FilterPattern.anyTerm(WEBHOOK_SIGNATURE_REJECTED),
			metricNamespace: "Tracewise/Billing",
			metricName: "WebhookSignatureRejected",
			metricValue: "1",
		});
		new Alarm(this, "BillingWebhookSignatureRejected", {
			alarmDescription: "Stripe webhook deliveries are failing the signature check: check webhook_secret in the Stripe secret matches the endpoint's signing secret",
			metric: signatureRejected.metric({ period: Duration.minutes(15), statistic: Stats.SUM }),
			threshold: 3,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		new Alarm(this, "BillingMeterErrors", {
			alarmDescription: "The hourly usage meter failed: paid orgs' usage wasn't reported to Stripe",
			metric: this.meterFn.metricErrors({ period: Duration.hours(1), statistic: Stats.SUM }),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		// The meter publishes MeterLastSuccessAgeMinutes = 0 only after a fully successful run, so
		// no datapoint for 3 hours (missing data counts as breaching) means usage is going unbilled,
		// whether the meter fails, partly fails or stops being invoked.
		new Alarm(this, "BillingMeterStale", {
			alarmDescription: "The usage meter hasn't fully succeeded for 3 hours: Stripe usage is falling behind",
			metric: new Metric({
				namespace: "Tracewise/Billing",
				metricName: "MeterLastSuccessAgeMinutes",
				statistic: Stats.SAMPLE_COUNT,
				period: Duration.hours(3),
			}),
			threshold: 1,
			comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.BREACHING,
		}).addAlarmAction(notify);
	}
}
