// Starts the evaluation workflow now instead of waiting for the nightly schedule,
// then waits for it to finish and prints each tenant's result.
// Usage: AWS_PROFILE=tracewise AWS_REGION=us-east-1 pnpm exec tsx scripts/run-evals.ts [YYYY-MM-DD]
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "Tracewise" }));
const arn = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "EvalWorkflow")?.OutputValue;
if (!arn) throw new Error("EvalWorkflow output not found: deploy first");

const sfn = new SFNClient({});
const { executionArn } = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ day }) }));
console.error(`evaluating ${day}…`);
const started = Date.now();
for (;;) {
	await new Promise((r) => setTimeout(r, 3000));
	const ex = await sfn.send(new DescribeExecutionCommand({ executionArn }));
	if (ex.status === "RUNNING") continue;
	console.error(`${ex.status} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
	console.log(ex.output ?? ex.error ?? ex.cause);
	process.exit(ex.status === "SUCCEEDED" ? 0 : 1);
}
