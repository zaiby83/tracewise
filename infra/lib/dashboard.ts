import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import {
	AllowedMethods,
	CacheCookieBehavior,
	CacheHeaderBehavior,
	CachePolicy,
	CacheQueryStringBehavior,
	Distribution,
	HeadersFrameOption,
	HeadersReferrerPolicy,
	OriginRequestPolicy,
	PriceClass,
	ResponseHeadersPolicy,
	ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

const site = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard");

export interface DashboardProps {
	api: HttpApi;
	// A read-only API key the public page uses to show the demo tenant. Read-only keys
	// can't ingest, so publishing one exposes only the demo data it's meant to show.
	demoReadKey?: string;
}

// The dashboard: static files in a private bucket, served through CloudFront, which
// also fronts the API on the same domain (/v1/*). One origin means no CORS, and
// CloudFront caches API reads briefly, shielding Athena and Lambda from a busy page.
export class Dashboard extends Construct {
	readonly distribution: Distribution;

	constructor(scope: Construct, id: string, props: DashboardProps) {
		super(scope, id);

		const bucket = new Bucket(this, "Site", {
			encryption: BucketEncryption.S3_MANAGED,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL, // only CloudFront can read it (OAC)
			enforceSSL: true,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		const securityHeaders = new ResponseHeadersPolicy(this, "SecurityHeaders", {
			securityHeadersBehavior: {
				// No third-party scripts, no inline script, no framing. The page talks only
				// to its own origin.
				contentSecurityPolicy: {
					contentSecurityPolicy:
						"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
					override: true,
				},
				strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
				contentTypeOptions: { override: true },
				frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
				referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
			},
		});

		// API reads are cached for up to a minute per key and query, so a burst of
		// visitors on the public page costs one Athena query, not hundreds. The key is
		// part of the cache key, so one tenant can never be served another's response.
		const apiCache = new CachePolicy(this, "ApiCache", {
			defaultTtl: Duration.seconds(60),
			minTtl: Duration.seconds(0),
			maxTtl: Duration.minutes(5),
			headerBehavior: CacheHeaderBehavior.allowList("authorization"),
			queryStringBehavior: CacheQueryStringBehavior.all(),
			cookieBehavior: CacheCookieBehavior.none(),
			enableAcceptEncodingGzip: true,
			enableAcceptEncodingBrotli: true,
		});

		const apiDomain = `${props.api.apiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}`;

		this.distribution = new Distribution(this, "Cdn", {
			comment: "Tracewise dashboard and API",
			defaultRootObject: "index.html",
			priceClass: PriceClass.PRICE_CLASS_100, // North America and Europe edges: cheapest
			defaultBehavior: {
				origin: S3BucketOrigin.withOriginAccessControl(bucket),
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				cachePolicy: CachePolicy.CACHING_OPTIMIZED,
				responseHeadersPolicy: securityHeaders,
			},
			additionalBehaviors: {
				"/v1/*": {
					origin: new HttpOrigin(apiDomain),
					viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
					allowedMethods: AllowedMethods.ALLOW_ALL,
					cachePolicy: apiCache,
					originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
				},
			},
		});

		new BucketDeployment(this, "Deploy", {
			destinationBucket: bucket,
			sources: [Source.asset(site), Source.jsonData("config.json", { demoKey: props.demoReadKey ?? "" })],
			distribution: this.distribution,
			distributionPaths: ["/*"],
			memoryLimit: 256,
		});
	}
}
