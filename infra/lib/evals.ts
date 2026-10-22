import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { AttributeType, Billing, TableEncryptionV2, TableV2, type ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { Schedule, ScheduleExpression, ScheduleTargetInput } from "aws-cdk-lib/aws-scheduler";
import { StepFunctionsStartExecution } from "aws-cdk-lib/aws-scheduler-targets";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import {
	Choice,
	Condition,
	DefinitionBody,
	JsonPath,
	LogLevel,
	Map as MapState,
	Pass,
	StateMachine,
	Succeed,
	TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

export interface EvalsProps {
	traces: ITableV2;
	tenants: ITableV2;
	alerts: ITopic;
	// Builds a Lambda the same way the rest of the stack does.
	fn: (name: string, entry: string, extra?: Partial<NodejsFunctionProps>) => NodejsFunction;
	judgeModel: string;
}

// The nightly evaluation workflow:
//   ListTenants → Map(tenant) { Sample → Map(trace) { Judge } → Record }
// Retries with backoff live in the workflow, not in code; a trace that can't be graded
// becomes a recorded failure instead of failing the tenant's run.
export class Evals extends Construct {
	readonly table: TableV2;
	readonly stateMachine: StateMachine;
	// Exposed so the stack can grant them the accounts and quota tables it owns.
	readonly listFn: NodejsFunction;
	readonly sampleFn: NodejsFunction;

	constructor(scope: Construct, id: string, props: EvalsProps) {
		super(scope, id);

		this.table = new TableV2(this, "Runs", {
			partitionKey: { name: "tenant_id", type: AttributeType.STRING },
			sortKey: { name: "run_at", type: AttributeType.STRING },
			billing: Billing.onDemand(),
			timeToLiveAttribute: "expires_at",
			encryption: TableEncryptionV2.awsManagedKey(),
			removalPolicy: RemovalPolicy.DESTROY,
		});

		// One module, four exported handlers.
		const entry = "evals/handlers.ts";
		const list = props.fn("EvalListTenants", entry, { handler: "listTenants", timeout: Duration.seconds(30) });
		const sample = props.fn("EvalSample", entry, { handler: "sample", timeout: Duration.seconds(60) });
		const judge = props.fn("EvalJudge", entry, { handler: "judge", timeout: Duration.seconds(60) });
		const record = props.fn("EvalRecord", entry, { handler: "record", timeout: Duration.seconds(30) });
		this.listFn = list;
		this.sampleFn = sample;

		props.tenants.grantReadData(list);
		props.traces.grantReadData(sample);
		props.traces.grantReadData(judge);
		// The judge calls the model; record stores which model graded the run.
		for (const f of [judge, record]) f.addEnvironment("JUDGE_MODEL", props.judgeModel);
		list.addEnvironment("TENANTS_TABLE", props.tenants.tableName);
		for (const f of [sample, judge]) f.addEnvironment("TRACES_TABLE", props.traces.tableName);
		record.addEnvironment("EVALS_TABLE", this.table.tableName);
		record.addEnvironment("ALERT_TOPIC", props.alerts.topicArn);
		this.table.grantReadWriteData(record);
		props.alerts.grantPublish(record);
		record.addToRolePolicy(
			new PolicyStatement({
				actions: ["cloudwatch:PutMetricData"],
				resources: ["*"], // PutMetricData has no resource-level permissions...
				conditions: { StringEquals: { "cloudwatch:namespace": "Tracewise/Evals" } }, // ...so scope by namespace
			}),
		);
		// listTenants reports when the global judge cap shrinks an org's budget.
		list.addToRolePolicy(
			new PolicyStatement({
				actions: ["cloudwatch:PutMetricData"],
				resources: ["*"],
				conditions: { StringEquals: { "cloudwatch:namespace": "Tracewise/Limits" } },
			}),
		);
		// Cross-region inference profiles route to the model in several US regions.
		const stack = Stack.of(this);
		judge.addToRolePolicy(
			new PolicyStatement({
				actions: ["bedrock:InvokeModel"],
				resources: [
					stack.formatArn({ service: "bedrock", resource: "inference-profile", resourceName: props.judgeModel }),
					`arn:${stack.partition}:bedrock:*::foundation-model/${props.judgeModel.replace(/^us\./, "")}`,
				],
			}),
		);

		// ---- Workflow -------------------------------------------------------------
		const listStep = new LambdaInvoke(this, "ListTenants", { lambdaFunction: list, payloadResponseOnly: true });

		const sampleStep = new LambdaInvoke(this, "Sample", { lambdaFunction: sample, payloadResponseOnly: true });

		const judgeStep = new LambdaInvoke(this, "Judge", {
			lambdaFunction: judge,
			payloadResponseOnly: true,
			retryOnServiceExceptions: true,
		});
		// Model throttling is expected at concurrency; back off and try again.
		judgeStep.addRetry({
			errors: ["ThrottlingException", "ServiceUnavailableException", "ModelNotReadyException", "InternalServerException"],
			interval: Duration.seconds(2),
			backoffRate: 2,
			maxAttempts: 5,
		});
		const gradeFailed = new Pass(this, "GradeFailed", {
			parameters: {
				"key.$": "$.key",
				event_id: "",
				route: "",
				scores: null,
				"error.$": "$.failure.Error",
			},
		});
		judgeStep.addCatch(gradeFailed, { resultPath: "$.failure" });

		const judgeEach = new MapState(this, "JudgeEach", {
			itemsPath: "$.keys",
			maxConcurrency: 4,
			itemSelector: { "key.$": "$$.Map.Item.Value", "rubric.$": "$.rubric" },
			resultPath: "$.results",
		});
		judgeEach.itemProcessor(judgeStep);

		const recordStep = new LambdaInvoke(this, "Record", {
			lambdaFunction: record,
			payloadResponseOnly: true,
			payload: TaskInput.fromObject({
				"tenant_id.$": "$.tenant_id",
				"name.$": "$.name",
				"day.$": "$.day",
				"sample_budget.$": "$.sample_budget",
				"sample_limit.$": "$.sample_limit",
				"results.$": "$.results",
			}),
		});

		const nothingToGrade = new Succeed(this, "NothingToGrade");
		const perTenant = sampleStep.next(
			new Choice(this, "AnyTraces")
				.when(Condition.isPresent("$.keys[0]"), judgeEach.next(recordStep))
				.otherwise(nothingToGrade),
		);

		const eachTenant = new MapState(this, "EachTenant", {
			itemsPath: "$.tenants",
			maxConcurrency: 2,
			// Step Functions passes on only the fields named here.
			itemSelector: {
				"tenant_id.$": "$$.Map.Item.Value.tenant_id",
				"name.$": "$$.Map.Item.Value.name",
				"day.$": "$$.Map.Item.Value.day",
				"rubric.$": "$$.Map.Item.Value.rubric",
				"sample_budget.$": "$$.Map.Item.Value.sample_budget",
				"sample_limit.$": "$$.Map.Item.Value.sample_limit",
			},
			// Each org's run is recorded by its own Record step; collecting every org's
			// output into one state would only push it towards the 256 KB limit.
			resultPath: JsonPath.DISCARD,
		});
		eachTenant.itemProcessor(perTenant);

		this.stateMachine = new StateMachine(this, "Workflow", {
			definitionBody: DefinitionBody.fromChainable(listStep.next(eachTenant)),
			timeout: Duration.hours(1),
			tracingEnabled: true,
			logs: {
				destination: new LogGroup(this, "WorkflowLogs", { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
				level: LogLevel.ERROR,
			},
		});

		// Nightly at 06:00 UTC, evaluating the previous day.
		new Schedule(this, "Nightly", {
			schedule: ScheduleExpression.cron({ minute: "0", hour: "6" }),
			target: new StepFunctionsStartExecution(this.stateMachine, { input: ScheduleTargetInput.fromObject({}) }),
			description: "Tracewise nightly evaluation run",
		});
	}
}
