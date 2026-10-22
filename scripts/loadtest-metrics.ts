// Pulls the server-side view of a load test window from CloudWatch: API latency,
// Lambda concurrency and errors, queue backlog, DynamoDB throttling, dead letters.
// Usage: AWS_PROFILE=tracewise AWS_REGION=us-east-1 pnpm exec tsx scripts/loadtest-metrics.ts <startISO> <endISO>
import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";

const [startArg, endArg] = process.argv.slice(2);
const start = new Date(startArg!);
const end = new Date(endArg ?? Date.now());

const { StackResources = [] } = await new CloudFormationClient({}).send(new DescribeStackResourcesCommand({ StackName: "Tracewise" }));
const physical = (type: string, logicalPrefix: string) =>
	StackResources.find((r) => r.ResourceType === type && r.LogicalResourceId?.startsWith(logicalPrefix))?.PhysicalResourceId!;
const apiId = physical("AWS::ApiGatewayV2::Api", "Api");
const ingest = physical("AWS::Lambda::Function", "Ingest");
const processor = physical("AWS::Lambda::Function", "Processor");
const queueName = physical("AWS::SQS::Queue", "IngestQueue").split("/").pop()!;
const dlqName = physical("AWS::SQS::Queue", "IngestDLQ").split("/").pop()!;
const tracesTable = physical("AWS::DynamoDB::GlobalTable", "Traces");

const q = (id: string, ns: string, metric: string, dims: Record<string, string>, stat: string): MetricDataQuery => ({
	Id: id,
	MetricStat: { Metric: { Namespace: ns, MetricName: metric, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })) }, Period: 60, Stat: stat },
});

const queries = [
	q("api_p50", "AWS/ApiGateway", "Latency", { ApiId: apiId, Stage: "$default" }, "p50"),
	q("api_p99", "AWS/ApiGateway", "Latency", { ApiId: apiId, Stage: "$default" }, "p99"),
	q("api_5xx", "AWS/ApiGateway", "5xx", { ApiId: apiId, Stage: "$default" }, "Sum"),
	q("api_4xx", "AWS/ApiGateway", "4xx", { ApiId: apiId, Stage: "$default" }, "Sum"),
	q("ingest_p99", "AWS/Lambda", "Duration", { FunctionName: ingest }, "p99"),
	q("ingest_conc", "AWS/Lambda", "ConcurrentExecutions", { FunctionName: ingest }, "Maximum"),
	q("ingest_throttles", "AWS/Lambda", "Throttles", { FunctionName: ingest }, "Sum"),
	q("proc_conc", "AWS/Lambda", "ConcurrentExecutions", { FunctionName: processor }, "Maximum"),
	q("proc_p50", "AWS/Lambda", "Duration", { FunctionName: processor }, "p50"),
	q("proc_errors", "AWS/Lambda", "Errors", { FunctionName: processor }, "Sum"),
	q("queue_age", "AWS/SQS", "ApproximateAgeOfOldestMessage", { QueueName: queueName }, "Maximum"),
	q("queue_visible", "AWS/SQS", "ApproximateNumberOfMessagesVisible", { QueueName: queueName }, "Maximum"),
	q("sent", "AWS/SQS", "NumberOfMessagesSent", { QueueName: queueName }, "Sum"),
	q("deleted", "AWS/SQS", "NumberOfMessagesDeleted", { QueueName: queueName }, "Sum"),
	q("dlq", "AWS/SQS", "ApproximateNumberOfMessagesVisible", { QueueName: dlqName }, "Maximum"),
	q("ddb_throttled", "AWS/DynamoDB", "WriteThrottleEvents", { TableName: tracesTable }, "Sum"),
	q("ddb_wcu", "AWS/DynamoDB", "ConsumedWriteCapacityUnits", { TableName: tracesTable }, "Sum"),
];

const { MetricDataResults = [] } = await new CloudWatchClient({}).send(
	new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: start, EndTime: end, ScanBy: "TimestampAscending" }),
);

// One row per minute, one column per metric.
const minutes = [...new Set(MetricDataResults.flatMap((r) => (r.Timestamps ?? []).map((t) => t.toISOString())))].sort();
const at = (id: string, t: string) => {
	const r = MetricDataResults.find((m) => m.Id === id);
	const i = (r?.Timestamps ?? []).findIndex((x) => x.toISOString() === t);
	return i < 0 ? null : r!.Values![i]!;
};
const cols = queries.map((x) => x.Id!);
console.log(["minute", ...cols].join("\t"));
for (const t of minutes) console.log([t.slice(11, 16), ...cols.map((c) => { const v = at(c, t); return v === null ? "-" : Number.isInteger(v) ? v : v.toFixed(1); })].join("\t"));
