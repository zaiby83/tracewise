import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, Metric, Stats, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import {
	AccountRecovery,
	CfnManagedLoginBranding,
	FeaturePlan,
	ManagedLoginVersion,
	Mfa,
	OAuthScope,
	UserPool,
	UserPoolClientIdentityProvider,
	type UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { CONSOLE_ROUTES, JWT_DATA_ROUTES, splitRouteKey } from "../../services/console/route-keys";

export interface AccountsProps {
	// Builds a Lambda the same way the rest of the stack does.
	fn: (name: string, entry: string, extra?: Partial<NodejsFunctionProps>) => NodejsFunction;
	accounts: ITableV2;
	keyIndex: ITableV2;
	quotas: ITableV2;
	// Only the deleter touches these three: it removes a deleted org's data.
	traces: ITableV2;
	evalRuns: ITableV2;
	lake: IBucket;
	alerts: ITopic;
	// Cognito's hosted domain is https://<prefix>.auth.<region>.amazoncognito.com.
	authDomainPrefix: string;
	// A password-auth client for the self-serve smoke test; off in normal deployments.
	smokeClient: boolean;
}

// Self-serve accounts: the Cognito user pool that says who a user is, the console API that
// manages orgs, members, invites and keys, and the deleter that removes an org's data in
// the background. Org membership lives in the Accounts table, not in Cognito.
export class Accounts extends Construct {
	readonly userPool: UserPool;
	// Built from the prefix, not the domain resource, so CloudFront's CSP can name it
	// without a dependency cycle (the console client's callback URL names CloudFront).
	readonly authDomainUrl: string;
	readonly consoleFn: NodejsFunction;
	readonly deleterFn: NodejsFunction;
	readonly deletionQueue: Queue;
	private readonly domain: UserPoolDomain;
	private readonly smokeClient: boolean;

	constructor(scope: Construct, id: string, props: AccountsProps) {
		super(scope, id);
		const region = Stack.of(this).region;
		this.smokeClient = props.smokeClient;

		// ---- Identity -------------------------------------------------------------
		this.userPool = new UserPool(this, "UserPool", {
			selfSignUpEnabled: true,
			signInAliases: { email: true },
			autoVerify: { email: true },
			// TOTP only: SMS costs money per message and is the weaker factor.
			mfa: Mfa.OPTIONAL,
			mfaSecondFactor: { sms: false, otp: true },
			featurePlan: FeaturePlan.ESSENTIALS, // needed for the newer managed login
			accountRecovery: AccountRecovery.EMAIL_ONLY,
			passwordPolicy: { minLength: 12 },
			removalPolicy: RemovalPolicy.DESTROY,
		});
		// Managed login hosts sign-up, sign-in, password reset and MFA, so the console has
		// no credential screens of its own.
		this.domain = this.userPool.addDomain("Domain", {
			cognitoDomain: { domainPrefix: props.authDomainPrefix },
			managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
		});
		this.authDomainUrl = `https://${props.authDomainPrefix}.auth.${region}.amazoncognito.com`;

		// ---- Deletion queue -------------------------------------------------------
		const deleterTimeout = Duration.seconds(60);
		const dlq = new Queue(this, "DeletionDLQ", {
			retentionPeriod: Duration.days(14),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
		});
		this.deletionQueue = new Queue(this, "DeletionQueue", {
			// AWS guidance: at least 6x the consumer's timeout.
			visibilityTimeout: Duration.seconds(deleterTimeout.toSeconds() * 6),
			retentionPeriod: Duration.days(4),
			encryption: QueueEncryption.SQS_MANAGED,
			enforceSSL: true,
			deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
		});

		// ---- Console --------------------------------------------------------------
		// The billing routes call Stripe, so the console gets just under API Gateway's 30 s integration
		// limit. That covers the common slow call, not every retry chain: the SDK's worst case (10 s x 3
		// attempts plus backoff) can still exceed 30 s, and the caller then sees a 503.
		this.consoleFn = props.fn("ConsoleFn", "console/handler.ts", { timeout: Duration.seconds(29) });
		this.consoleFn.addEnvironment("ACCOUNTS_TABLE", props.accounts.tableName);
		this.consoleFn.addEnvironment("TENANTS_TABLE", props.keyIndex.tableName);
		this.consoleFn.addEnvironment("QUOTAS_TABLE", props.quotas.tableName);
		this.consoleFn.addEnvironment("DELETION_QUEUE_URL", this.deletionQueue.queueUrl);
		// Least privilege: the console manages accounts, keys and the counters behind
		// limits and usage, and queues deletions. It has no access to traces, the lake or
		// eval runs; deleting an org's data is the deleter's job.
		props.accounts.grantReadWriteData(this.consoleFn);
		props.keyIndex.grantReadWriteData(this.consoleFn);
		props.quotas.grantReadWriteData(this.consoleFn);
		this.deletionQueue.grantSendMessages(this.consoleFn);
		this.consoleFn.addToRolePolicy(
			new PolicyStatement({
				actions: ["cloudwatch:PutMetricData"],
				resources: ["*"], // PutMetricData has no resource-level permissions...
				conditions: { StringEquals: { "cloudwatch:namespace": "Tracewise/Limits" } }, // ...so scope by namespace
			}),
		);

		// ---- Deleter --------------------------------------------------------------
		// A worst-case run is ~80 DynamoDB batch writes with backoff, or 3 S3 list and
		// delete rounds; each run then queues the next step of the deletion.
		this.deleterFn = props.fn("DeleterFn", "deleter/handler.ts", { timeout: deleterTimeout });
		this.deleterFn.addEnvironment("TRACES_TABLE", props.traces.tableName);
		this.deleterFn.addEnvironment("EVALS_TABLE", props.evalRuns.tableName);
		this.deleterFn.addEnvironment("ACCOUNTS_TABLE", props.accounts.tableName);
		this.deleterFn.addEnvironment("TENANTS_TABLE", props.keyIndex.tableName);
		this.deleterFn.addEnvironment("LAKE_BUCKET", props.lake.bucketName);
		this.deleterFn.addEnvironment("DELETION_QUEUE_URL", this.deletionQueue.queueUrl);
		for (const table of [props.traces, props.evalRuns, props.accounts, props.keyIndex]) table.grantReadWriteData(this.deleterFn);
		// The lake: list only tenant prefixes, and delete only trace objects. errors/ and
		// athena-results/ expire by lifecycle rule instead.
		this.deleterFn.addToRolePolicy(
			new PolicyStatement({
				actions: ["s3:ListBucket"],
				resources: [props.lake.bucketArn],
				conditions: { StringLike: { "s3:prefix": "traces/tenant_id=*" } },
			}),
		);
		this.deleterFn.addToRolePolicy(new PolicyStatement({ actions: ["s3:DeleteObject"], resources: [props.lake.arnForObjects("traces/*")] }));
		this.deletionQueue.grantSendMessages(this.deleterFn);
		// One org's step per invocation, so a failing step retries alone.
		this.deleterFn.addEventSource(new SqsEventSource(this.deletionQueue, { batchSize: 1, reportBatchItemFailures: true }));

		// ---- Alarms ---------------------------------------------------------------
		const notify = new SnsAction(props.alerts);

		new Alarm(this, "DeletionDeadLetters", {
			alarmDescription: "An org deletion step failed 5 times and was dead-lettered: the org is stuck in deleting",
			metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
			threshold: 0,
			comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);

		const capHit = (cap: "orgs" | "judge") =>
			new Metric({
				namespace: "Tracewise/Limits",
				metricName: "GlobalCapHit",
				dimensionsMap: { Cap: cap },
				statistic: Stats.SUM,
				period: Duration.minutes(5),
			});
		new Alarm(this, "GlobalOrgCap", {
			alarmDescription: "The service-wide cap on new orgs per day was hit: sign-ups are being turned away",
			metric: capHit("orgs"),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);
		new Alarm(this, "GlobalJudgeCap", {
			alarmDescription: "The nightly judge-call cap shrank some orgs' eval samples below their limit",
			metric: capHit("judge"),
			threshold: 1,
			comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
			evaluationPeriods: 1,
			treatMissingData: TreatMissingData.NOT_BREACHING,
		}).addAlarmAction(notify);
	}

	// Wires the console to the API once the dashboard's origin is known: the app client
	// (whose callback is on that origin), the JWT authorizer, and the session routes.
	connect(api: HttpApi, origin: string, data: { query: IFunction; summary: IFunction; evalsApi: IFunction }): { clientId: string; smokeClientId?: string } {
		this.consoleFn.addEnvironment("CONSOLE_ORIGIN", origin); // invite links point here

		// A public client (no secret) using the authorization-code flow with PKCE. The file
		// path, not /console/, because S3 behind OAC doesn't serve directory indexes.
		const consoleUrl = `${origin}/console/index.html`;
		const client = this.userPool.addClient("ConsoleClient", {
			generateSecret: false,
			// Managed login only. Listed explicitly because Cognito's default set includes
			// ALLOW_REFRESH_TOKEN_AUTH, which can't be combined with refresh token rotation.
			authFlows: { userSrp: true },
			oAuth: {
				flows: { authorizationCodeGrant: true },
				scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
				callbackUrls: [consoleUrl],
				logoutUrls: [consoleUrl],
			},
			supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
			refreshTokenValidity: Duration.days(30),
			// Rotation: each refresh returns a new refresh token, and the old one is honoured
			// for 10 more seconds so a retried request still succeeds.
			refreshTokenRotationGracePeriod: Duration.seconds(10),
			enableTokenRevocation: true,
			preventUserExistenceErrors: true,
		});
		// The newer managed login needs a branding style; Cognito's defaults are enough.
		const branding = new CfnManagedLoginBranding(this, "ConsoleBranding", {
			userPoolId: this.userPool.userPoolId,
			clientId: client.userPoolClientId,
			useCognitoProvidedValues: true,
		});
		branding.node.addDependency(this.domain);

		// The smoke test signs in with a password through the admin API: no OAuth, no browser.
		const smoke = this.smokeClient
			? this.userPool.addClient("SmokeClient", { generateSecret: false, authFlows: { adminUserPassword: true }, disableOAuth: true })
			: undefined;

		// The console sends the ID token, whose aud is the client ID.
		const authorizer = new HttpJwtAuthorizer("CognitoAuthorizer", `https://cognito-idp.${Stack.of(this).region}.amazonaws.com/${this.userPool.userPoolId}`, {
			jwtAudience: [client.userPoolClientId, ...(smoke ? [smoke.userPoolClientId] : [])],
			identitySource: ["$request.header.Authorization"],
		});

		const route = (key: string, integration: HttpLambdaIntegration) => {
			const { method, path } = splitRouteKey(key);
			api.addRoutes({ path, methods: [method as HttpMethod], integration, authorizer });
		};
		const consoleIntegration = new HttpLambdaIntegration("ConsoleRoute", this.consoleFn);
		for (const key of CONSOLE_ROUTES) route(key, consoleIntegration);
		// The data routes under /v1/orgs/{orgId}/ reuse the existing functions, which tell a
		// session from an API key by the authorizer's claims.
		for (const name of Object.keys(JWT_DATA_ROUTES) as (keyof typeof JWT_DATA_ROUTES)[])
			route(JWT_DATA_ROUTES[name], new HttpLambdaIntegration(`${name.charAt(0).toUpperCase()}${name.slice(1)}SessionRoute`, data[name]));

		return { clientId: client.userPoolClientId, smokeClientId: smoke?.userPoolClientId };
	}
}
