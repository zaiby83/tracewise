import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// One client for every module. It lives apart from tenants.ts so accounts.ts and
// tenants.ts can both use it without importing each other.
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
	marshallOptions: { removeUndefinedValues: true },
});
