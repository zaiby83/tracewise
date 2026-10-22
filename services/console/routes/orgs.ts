import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import { GLOBAL_ORGS_PER_DAY, MAX_OWNED_ORGS, getProfile, listUserOrgs } from "../../shared/accounts";
import { json, log } from "../../shared/http";
import { consumeCounter, counterIds } from "../../shared/tenants";
import type { Ctx, RouteTable } from "../handler";
import { cancelDeletion, countOwnedOrgs, createOrg, startDeletion, updateProfile } from "../store";
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
		run: async (ctx) => {
			// Membership rows outlive an org's deletion until the deleter's last phase, so the profile
			// decides: an org that is deleting, deleted or missing is not listed.
			const rows = await listUserOrgs(ctx.claims.sub);
			const profiles = await Promise.all(rows.map((r) => getProfile(r.org_id)));
			return json(200, { orgs: rows.filter((_, i) => profiles[i]?.status === "active") });
		},
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
			try {
				await sqs.send(new SendMessageCommand({ QueueUrl: process.env.DELETION_QUEUE_URL, MessageBody: JSON.stringify({ org_id: orgId, phase: "dynamo" }) }));
			} catch {
				// Without a queued deleter the org would sit hidden in `deleting` and the owner couldn't
				// retry, so put it back. The order stays: queueing first could delete an active org's data.
				log("error", "deletion enqueue failed", { org_id: orgId });
				try {
					await cancelDeletion(orgId);
				} catch {
					log("error", "deletion rollback failed", { org_id: orgId });
				}
				return json(503, { error: "couldn't start deletion, try again" });
			}
			return json(202, { status: "deleting" });
		},
	},
};
