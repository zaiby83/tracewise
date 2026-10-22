import { SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenant = { tenant_id: "tenant-1", name: "Acme", status: "active", events_per_minute: 1000 };
const tenants = vi.hoisted(() => ({ tenantForKey: vi.fn(), consumeQuota: vi.fn() }));
vi.mock("../services/shared/tenants", () => tenants);

const { handler } = await import("../services/ingest/handler");
const KEY = `tw_${"a".repeat(43)}`;

const request = (body: unknown, auth = `Bearer ${KEY}`) =>
	({ headers: { authorization: auth }, body: JSON.stringify(body), isBase64Encoded: false }) as unknown as APIGatewayProxyEventV2;
const event = () => ({ event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "m", input: "i", output: "o", latency_ms: 5 });

describe("ingest handler", () => {
	let send: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		tenants.tenantForKey.mockResolvedValue(tenant);
		tenants.consumeQuota.mockResolvedValue(true);
		send = vi.spyOn(SQSClient.prototype, "send").mockResolvedValue({ Failed: [] } as never);
	});

	it("enqueues valid events in batches of 10 and stamps the tenant", async () => {
		const res = await handler(request({ events: Array.from({ length: 25 }, event) }));
		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body!)).toMatchObject({ accepted: 25, rejected: [] });
		expect(send).toHaveBeenCalledTimes(3);
		const first = (send.mock.calls[0]![0] as { input: { Entries: { MessageBody: string }[] } }).input.Entries[0]!;
		expect(JSON.parse(first.MessageBody)).toMatchObject({ tenant_id: "tenant-1", received_at: expect.any(String) });
	});

	it("never trusts a tenant id sent by the client", async () => {
		await handler(request({ events: [{ ...event(), tenant_id: "someone-else" }] }));
		const body = (send.mock.calls[0]![0] as { input: { Entries: { MessageBody: string }[] } }).input.Entries[0]!.MessageBody;
		expect(JSON.parse(body).tenant_id).toBe("tenant-1");
	});

	it("rejects missing and unknown keys", async () => {
		expect((await handler(request({ events: [event()] }, ""))).statusCode).toBe(401);
		tenants.tenantForKey.mockResolvedValue(null);
		expect((await handler(request({ events: [event()] }))).statusCode).toBe(401);
		expect(send).not.toHaveBeenCalled();
	});

	it("returns 429 when the tenant is over quota", async () => {
		tenants.consumeQuota.mockResolvedValue(false);
		const res = await handler(request({ events: [event()] }));
		expect(res.statusCode).toBe(429);
		expect(send).not.toHaveBeenCalled();
	});

	it("retries partially failed SQS entries once, then asks the client to retry", async () => {
		send.mockResolvedValueOnce({ Failed: [{ Id: "0" }] } as never).mockResolvedValueOnce({ Failed: [] } as never);
		expect((await handler(request({ events: [event()] }))).statusCode).toBe(202);

		send.mockResolvedValue({ Failed: [{ Id: "0" }] } as never);
		expect((await handler(request({ events: [event()] }))).statusCode).toBe(503);
	});

	it("rejects malformed bodies and oversized batches", async () => {
		expect((await handler({ ...request({}), body: "not json" } as APIGatewayProxyEventV2)).statusCode).toBe(400);
		expect((await handler(request({ events: Array.from({ length: 101 }, event) }))).statusCode).toBe(400);
		expect((await handler(request({ events: [{ junk: true }] }))).statusCode).toBe(400);
	});
});
