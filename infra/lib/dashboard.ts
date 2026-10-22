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
	// Cognito's managed login domain, which the console signs in through.
	authDomainUrl: string;
}

// What the pages read from /config.json at runtime.
export interface DashboardConfig {
	// A read-only API key the public page uses to show the demo tenant. Read-only keys
	// can't ingest, so publishing one exposes only the demo data it's meant to show.
	demoKey: string;
	// The console's sign-in: the managed login domain and the public app client.
	auth: { domain: string; clientId: string };
}

// The dashboard: static files in a private bucket, served through CloudFront, which
// also fronts the API on the same domain (/v1/*). One origin means no CORS, and
// CloudFront caches API reads briefly, shielding Athena and Lambda from a busy page.
export class Dashboard extends Construct {
	readonly distribution: Distribution;
	readonly authDomainUrl: string;
	private readonly bucket: Bucket;

	constructor(scope: Construct, id: string, props: DashboardProps) {
		super(scope, id);
		this.authDomainUrl = props.authDomainUrl;

		const bucket = new Bucket(this, "Site", {
			encryption: BucketEncryption.S3_MANAGED,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL, // only CloudFront can read it (OAC)
			enforceSSL: true,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		// No third-party scripts, no inline script, no framing. The page talks only to its
		// own origin; the console also reaches Cognito's token endpoint to refresh sessions.
		const headersPolicy = (id: string, connectSrc: string) =>
			new ResponseHeadersPolicy(this, id, {
				securityHeadersBehavior: {
					contentSecurityPolicy: {
						contentSecurityPolicy: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
						override: true,
					},
					strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
					contentTypeOptions: { override: true },
					frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
					referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
				},
			});
		const securityHeaders = headersPolicy("SecurityHeaders", "'self'");
		const consoleHeaders = headersPolicy("ConsoleHeaders", `'self' ${props.authDomainUrl}`);

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

		const siteOrigin = S3BucketOrigin.withOriginAccessControl(bucket);
		const apiOrigin = new HttpOrigin(apiDomain);
		// The console's own calls (orgs, keys, members, invites) must never be cached: the
		// /v1/* cache would serve a stale key list right after one is created.
		const uncachedApi = {
			origin: apiOrigin,
			viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
			allowedMethods: AllowedMethods.ALLOW_ALL,
			cachePolicy: CachePolicy.CACHING_DISABLED,
			originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
		};

		this.bucket = bucket;
		this.distribution = new Distribution(this, "Cdn", {
			comment: "Tracewise dashboard and API",
			defaultRootObject: "index.html",
			priceClass: PriceClass.PRICE_CLASS_100, // North America and Europe edges: cheapest
			defaultBehavior: {
				origin: siteOrigin,
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				cachePolicy: CachePolicy.CACHING_OPTIMIZED,
				responseHeadersPolicy: securityHeaders,
			},
			// Insertion order is CloudFront's precedence, so the uncached routes come before
			// the cached /v1/*.
			additionalBehaviors: {
				"/v1/orgs*": uncachedApi,
				"/v1/invites/*": uncachedApi,
				"/v1/*": {
					origin: apiOrigin,
					viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
					allowedMethods: AllowedMethods.ALLOW_ALL,
					cachePolicy: apiCache,
					originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
				},
				"/console/*": {
					origin: siteOrigin,
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					cachePolicy: CachePolicy.CACHING_OPTIMIZED,
					responseHeadersPolicy: consoleHeaders,
				},
			},
		});
	}

	// Uploads the site with its config. Separate from the constructor because the config
	// names the console's app client, which can only exist once the distribution's domain
	// (its callback URL) is known.
	deploy(config: DashboardConfig) {
		new BucketDeployment(this, "Deploy", {
			destinationBucket: this.bucket,
			sources: [Source.asset(site), Source.jsonData("config.json", { demoKey: config.demoKey, auth: { domain: config.auth.domain, clientId: config.auth.clientId } })],
			distribution: this.distribution,
			distributionPaths: ["/*"],
			memoryLimit: 256,
		});
	}
}
