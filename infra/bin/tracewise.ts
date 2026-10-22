import { App, Tags } from "aws-cdk-lib";
import { TracewiseStack } from "../lib/tracewise-stack";

const app = new App();
const stack = new TracewiseStack(app, "Tracewise", {
	env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
	alarmEmail: app.node.tryGetContext("alarmEmail"),
});
// Tags make the project's spend visible in Cost Explorer.
Tags.of(stack).add("project", "tracewise");
