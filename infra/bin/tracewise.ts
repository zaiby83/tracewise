import { App, Tags } from "aws-cdk-lib";
import { TracewiseStack } from "../lib/tracewise-stack";

function numberContext(app: App, key: string): number | undefined {
	const value = app.node.tryGetContext(key);
	return value === undefined ? undefined : Number(value);
}

const app = new App();
const stack = new TracewiseStack(app, "Tracewise", {
	env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
	alarmEmail: app.node.tryGetContext("alarmEmail"),
	batchingWindowSeconds: numberContext(app, "batchingWindow"),
	batchSize: numberContext(app, "batchSize"),
});
// Tags make the project's spend visible in Cost Explorer.
Tags.of(stack).add("project", "tracewise");
