import { Aws, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { CfnWorkGroup } from "aws-cdk-lib/aws-athena";
import { CfnDatabase, CfnTable } from "aws-cdk-lib/aws-glue";
import { PolicyStatement, Role, ServicePrincipal, type IGrantable } from "aws-cdk-lib/aws-iam";
import { CfnDeliveryStream } from "aws-cdk-lib/aws-kinesisfirehose";
import { LogGroup, LogStream, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption, StorageClass } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

// Trace columns as stored in Parquet. tenant_id and dt are partitions, not columns.
const COLUMNS: CfnTable.ColumnProperty[] = [
	{ name: "event_id", type: "string" },
	{ name: "ts", type: "string" },
	{ name: "model", type: "string" },
	{ name: "provider", type: "string" },
	{ name: "route", type: "string" },
	{ name: "input", type: "string" },
	{ name: "output", type: "string" },
	{ name: "status", type: "string" },
	{ name: "latency_ms", type: "int" },
	{ name: "tokens_in", type: "int" },
	{ name: "tokens_out", type: "int" },
	{ name: "cost_usd", type: "double" },
	{ name: "security", type: "struct<verdict:string,rules:array<string>>" },
	{ name: "metadata", type: "map<string,string>" },
	{ name: "received_at", type: "string" },
	{ name: "processed_at", type: "string" },
];

export interface AnalyticsProps {
	// Per-query scan limit: Athena cancels any query that would read more than this.
	bytesScannedCutoffPerQuery?: number;
	// How long cold analytics data is kept.
	retentionDays?: number;
}

// The data lake: Firehose converts trace JSON to Parquet and writes it to S3 partitioned
// by tenant and day; Glue describes it; Athena queries it, pay-per-query.
export class Analytics extends Construct {
	readonly bucket: Bucket;
	readonly deliveryStream: CfnDeliveryStream;
	readonly database: string;
	readonly table: string;
	readonly workGroup: CfnWorkGroup;

	constructor(scope: Construct, id: string, props: AnalyticsProps = {}) {
		super(scope, id);
		const retentionDays = props.retentionDays ?? 365;

		this.bucket = new Bucket(this, "Lake", {
			encryption: BucketEncryption.S3_MANAGED,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true, // demo project: `cdk destroy` empties and removes it
			lifecycleRules: [
				{
					prefix: "traces/",
					transitions: [{ storageClass: StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) }],
					expiration: Duration.days(retentionDays),
				},
				{ prefix: "errors/", expiration: Duration.days(14) },
				{ prefix: "athena-results/", expiration: Duration.days(7) },
			],
		});

		// ---- Catalog ------------------------------------------------------------------
		this.database = "tracewise";
		const db = new CfnDatabase(this, "Database", {
			catalogId: Aws.ACCOUNT_ID,
			databaseInput: { name: this.database, description: "Tracewise trace data lake" },
		});

		this.table = "traces";
		const location = `s3://${this.bucket.bucketName}/traces/`;
		const table = new CfnTable(this, "Table", {
			catalogId: Aws.ACCOUNT_ID,
			databaseName: this.database,
			tableInput: {
				name: this.table,
				tableType: "EXTERNAL_TABLE",
				parameters: {
					classification: "parquet",
					// Partition projection: Athena computes partition locations from these
					// rules, so there are no crawlers or partition loads to run. "injected"
					// means a query must name the tenant, so it only ever reads one prefix.
					"projection.enabled": "true",
					"projection.tenant_id.type": "injected",
					"projection.dt.type": "date",
					"projection.dt.format": "yyyy-MM-dd",
					"projection.dt.range": "2026-01-01,NOW",
					"projection.dt.interval": "1",
					"projection.dt.interval.unit": "DAYS",
					"storage.location.template": `${location}tenant_id=\${tenant_id}/dt=\${dt}/`,
				},
				partitionKeys: [
					{ name: "tenant_id", type: "string" },
					{ name: "dt", type: "string" },
				],
				storageDescriptor: {
					columns: COLUMNS,
					location,
					inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
					outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
					serdeInfo: { serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe" },
				},
			},
		});
		table.addDependency(db);

		// ---- Firehose ---------------------------------------------------------------
		const logGroup = new LogGroup(this, "FirehoseLogs", { retention: RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
		const logStream = new LogStream(this, "FirehoseS3Delivery", { logGroup, removalPolicy: RemovalPolicy.DESTROY });

		const role = new Role(this, "FirehoseRole", { assumedBy: new ServicePrincipal("firehose.amazonaws.com") });
		this.bucket.grantReadWrite(role, "traces/*");
		this.bucket.grantReadWrite(role, "errors/*");
		this.bucket.grantRead(role); // ListBucket / GetBucketLocation
		const tableArn = Stack.of(this).formatArn({ service: "glue", resource: "table", resourceName: `${this.database}/${this.table}` });
		const dbArn = Stack.of(this).formatArn({ service: "glue", resource: "database", resourceName: this.database });
		const catalogArn = Stack.of(this).formatArn({ service: "glue", resource: "catalog" });
		// Firehose reads the table schema to convert JSON to Parquet.
		role.addToPolicy(new PolicyStatement({ actions: ["glue:GetTable", "glue:GetTableVersion", "glue:GetTableVersions"], resources: [catalogArn, dbArn, tableArn] }));
		logGroup.grantWrite(role);

		this.deliveryStream = new CfnDeliveryStream(this, "Stream", {
			deliveryStreamType: "DirectPut",
			deliveryStreamEncryptionConfigurationInput: { keyType: "AWS_OWNED_CMK" },
			extendedS3DestinationConfiguration: {
				bucketArn: this.bucket.bucketArn,
				roleArn: role.roleArn,
				// Dynamic partitioning: one prefix per tenant per day, matching the projection.
				prefix: "traces/tenant_id=!{partitionKeyFromQuery:tenant_id}/dt=!{partitionKeyFromQuery:dt}/",
				errorOutputPrefix: "errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/",
				// Dynamic partitioning requires a buffer of at least 64 MB; at low volume the
				// 60-second interval is what triggers delivery.
				bufferingHints: { sizeInMBs: 64, intervalInSeconds: 60 },
				// Parquet applies its own (Snappy) compression.
				compressionFormat: "UNCOMPRESSED",
				dynamicPartitioningConfiguration: { enabled: true, retryOptions: { durationInSeconds: 300 } },
				processingConfiguration: {
					enabled: true,
					processors: [
						{
							type: "MetadataExtraction",
							parameters: [
								{ parameterName: "MetadataExtractionQuery", parameterValue: "{tenant_id: .tenant_id, dt: .ts[0:10]}" },
								{ parameterName: "JsonParsingEngine", parameterValue: "JQ-1.6" },
							],
						},
					],
				},
				dataFormatConversionConfiguration: {
					enabled: true,
					inputFormatConfiguration: { deserializer: { openXJsonSerDe: {} } },
					outputFormatConfiguration: { serializer: { parquetSerDe: { compression: "SNAPPY" } } },
					schemaConfiguration: {
						catalogId: Aws.ACCOUNT_ID,
						databaseName: this.database,
						tableName: this.table,
						region: Aws.REGION,
						roleArn: role.roleArn,
						versionId: "LATEST",
					},
				},
				cloudWatchLoggingOptions: { enabled: true, logGroupName: logGroup.logGroupName, logStreamName: logStream.logStreamName },
			},
		});
		this.deliveryStream.node.addDependency(role);
		this.deliveryStream.addDependency(table);

		// ---- Athena -----------------------------------------------------------------
		this.workGroup = new CfnWorkGroup(this, "WorkGroup", {
			name: "tracewise",
			recursiveDeleteOption: true,
			workGroupConfiguration: {
				// Workgroup settings override client settings, so callers can't lift the
				// scan cap or move results elsewhere.
				enforceWorkGroupConfiguration: true,
				bytesScannedCutoffPerQuery: props.bytesScannedCutoffPerQuery ?? 1024 ** 3, // 1 GB
				publishCloudWatchMetricsEnabled: true,
				resultConfiguration: {
					outputLocation: `s3://${this.bucket.bucketName}/athena-results/`,
					encryptionConfiguration: { encryptionOption: "SSE_S3" },
				},
				engineVersion: { selectedEngineVersion: "AUTO" },
			},
		});
	}

	grantPut(grantee: IGrantable) {
		grantee.grantPrincipal.addToPrincipalPolicy(
			new PolicyStatement({ actions: ["firehose:PutRecordBatch"], resources: [this.deliveryStream.attrArn] }),
		);
	}

	// Run queries in this workgroup and read the lake and catalog. Nothing else.
	grantQuery(grantee: IGrantable) {
		const stack = Stack.of(this);
		const add = (actions: string[], resources: string[]) =>
			grantee.grantPrincipal.addToPrincipalPolicy(new PolicyStatement({ actions, resources }));
		add(
			["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"],
			[stack.formatArn({ service: "athena", resource: "workgroup", resourceName: this.workGroup.name })],
		);
		add(
			["glue:GetDatabase", "glue:GetTable", "glue:GetPartitions"],
			[
				stack.formatArn({ service: "glue", resource: "catalog" }),
				stack.formatArn({ service: "glue", resource: "database", resourceName: this.database }),
				stack.formatArn({ service: "glue", resource: "table", resourceName: `${this.database}/${this.table}` }),
			],
		);
		this.bucket.grantRead(grantee, "traces/*");
		this.bucket.grantReadWrite(grantee, "athena-results/*");
		add(["s3:GetBucketLocation", "s3:ListBucket"], [this.bucket.bucketArn]);
	}
}
