import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { GLOBAL_ORGS_PER_DAY, MAX_OWNED_ORGS, listUserOrgs } from "../../shared/accounts";
import { json, log } from "../../shared/http";
import { consumeCounter, counterIds } from "../../shared/tenants";
import type { Ctx, RouteTable } from "../handler";
import { countOwnedOrgs, createOrg, startDeletion, updateProfile } from "../store";
import { bodyOf, keyView, notFound, orgView } from "./common";

const sqs = new SQSClient({});
const cloudwatch = new CloudWatchClient({});

const orgName = z.string().trim().min(1).max(100);
const Create = z.object({ name: orgName });
const Patch = z
	.object({ name: orgName.optional(), rubric: z.string().max(4000).nullable().optional(), evals_enabled: z.boolean().optional() })
	.refine((p) => Object.values(p).some((v) => v !== undefined), { message: "at least one field is required" });
const Delete = z.object({ confirm_name: z.string() });

const paused = () => json(429, { error: "sign-ups are paused, try again tomorrow" });

async function create(ctx: Ctx) {
	const { name } = bodyOf(Create, ctx);
	const { sub, email } = ctx.claims;
	if ((await countOwnedOrgs(sub)) >= MAX_OWNED_ORGS) return paused();

	const now = Date.now();
	// Two days keeps the row past the end of its UTC day, whenever in the day it was created.
	if (!(await consumeCounter(counterIds.globalOrgs(now), 1, GLOBAL_ORGS_PER_DAY, Math.floor(now / 1000) + 2 * 86_400))) {
		// The alarm on this metric tells the operator the service-wide cap is being hit.
		try {
			await cloudwatch.send(
				new PutMetricDataCommand({
					Namespace: "Tracewise/Limits",
					MetricData: [{ MetricName: "GlobalCapHit", Dimensions: [{ Name: "Cap", Value: "orgs" }], Value: 1, Unit: "Count" }],
				}),
			);
		} catch (e) {
			// Reporting is best effort: the caller still gets the 429 they are owed.
			log("warn", "could not publish GlobalCapHit", { sub, error: e instanceof Error ? e.message : String(e) });
		}
		return paused();
	}

	const { org, key } = await createOrg({ name, owner: { sub, email } });
	return json(201, { org: orgView(org, "owner"), key: { ...keyView(key.record), secret: key.secret } });
}

export const orgRoutes: RouteTable = {
	"GET /v1/orgs": {
		access: "user",
		run: async (ctx) => json(200, { orgs: await listUserOrgs(ctx.claims.sub) }),
	},
	"POST /v1/orgs": { access: "user", verified: true, run: create },
	"GET /v1/orgs/{orgId}": {
		access: "member",
		run: async (ctx) => json(200, orgView(ctx.profile!, ctx.member!.role)),
	},
	"PATCH /v1/orgs/{orgId}": {
		access: "owner",
		run: async (ctx) => {
			// Only the parsed, whitelisted fields reach the store: it writes every key it is given.
			const patch = bodyOf(Patch, ctx);
			return json(200, orgView(await updateProfile(ctx.profile!.org_id, patch), ctx.member!.role));
		},
	},
	"DELETE /v1/orgs/{orgId}": {
		access: "owner",
		run: async (ctx) => {
			const { confirm_name } = bodyOf(Delete, ctx);
			if (confirm_name !== ctx.profile!.name) return json(400, { error: "confirm_name does not match the organisation name" });
			const orgId = ctx.profile!.org_id;
			// False means another request already moved the org out of active.
			if (!(await startDeletion(orgId))) return notFound();
			await sqs.send(new SendMessageCommand({ QueueUrl: process.env.DELETION_QUEUE_URL, MessageBody: JSON.stringify({ org_id: orgId, phase: "dynamo" }) }));
			return json(202, { status: "deleting" });
		},
	},
};
