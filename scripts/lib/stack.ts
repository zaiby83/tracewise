import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

// The operator scripts find the deployed resources through the stack's outputs. This also
// points the store at them: it reads these variables when it runs, as it does in Lambda.
export async function stackOutputs(): Promise<Record<string, string>> {
	const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "Tracewise" }));
	const outputs: Record<string, string> = {};
	for (const o of Stacks?.[0]?.Outputs ?? []) if (o.OutputKey && o.OutputValue) outputs[o.OutputKey] = o.OutputValue;
	if (!outputs.TenantsTable || !outputs.AccountsTable) throw new Error("Tracewise stack not found: deploy it first");
	process.env.ACCOUNTS_TABLE = outputs.AccountsTable;
	process.env.TENANTS_TABLE = outputs.TenantsTable;
	// Absent on a stack deployed before billing; only the billing scripts read it.
	if (outputs.QuotasTable) process.env.QUOTAS_TABLE = outputs.QuotasTable;
	if (outputs.DashboardUrl) process.env.CONSOLE_ORIGIN = outputs.DashboardUrl;
	return outputs;
}
