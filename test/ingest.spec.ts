import { SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenants = vi.hoisted(() => ({
	tenantForKey: vi.fn(),
	consumeQuota: vi.fn(),
	canWrite: (t: { scope?: string }) => (t.scope ?? "write") === "write",
	releaseQuota: vi.fn(),
	secondsUntil: vi.fn(() => 3600),
}));
vi.mock("../services/shared/tenants", () => tenants);
const accounts = vi.hoisted(() => ({ touchKey: vi.fn() }));
vi.mock("../services/shared/accounts", () => accounts);

const { FREE_LIMITS } = await vi.importActual<typeof import("../services/shared/accounts")>("../services/shared/accounts");
const tenant = { tenant_id: "tenant-1", org_id: "tenant-1", key_id: "k1", name: "Acme", status: "active", plan: "free", retention_days: 7, period_start: "2026-10-01", period_end: "2026-11-01", limits: FREE_LIMITS, rubric: null, evals_enabled: true };

const { handler } = await import("../services/ingest/handler");
const KEY = `tw_${"a".repeat(43)}`;

const request = (body: unknown, auth = `Bearer ${KEY}`) =>
	({ headers: { authorization: auth }, body: JSON.stringify(body), isBase64Encoded: false }) as unknown as APIGatewayProxyEventV2;
const event = () => ({ event_id: crypto.randomUUID(), ts: new Date().toISOString(), model: "m", input: "i", output: "o", latency_ms: 5 });

describe("ingest handler", () => {
	let send: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		tenants.tenantForKey.mockResolvedValue(tenant);
		tenants.consumeQuota.mockResolvedValue("ok");
		tenants.releaseQuota.mockReset();
		tenants.secondsUntil.mockClear();
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

	it("returns 429 minute with a 60 second retry", async () => {
		tenants.consumeQuota.mockResolvedValue("minute");
		const res = await handler(request({ events: [event()] }));
		expect(res.statusCode).toBe(429);
		expect(res.headers).toMatchObject({ "x-tracewise-limit": "minute", "retry-after": "60" });
		expect(send).not.toHaveBeenCalled();
	});

	it.each([["month", "free", "monthly event allowance used"], ["spend_cap", "team", "spend cap reached"]])("returns 429 %s with retry-after to the period end", async (limit, plan, error) => {
		tenants.tenantForKey.mockResolvedValue({ ...tenant, plan });
		tenants.consumeQuota.mockResolvedValue(limit);
		const res = await handler(request({ events: [event()] }));
		expect(res.statusCode).toBe(429);
		expect(res.headers).toMatchObject({ "x-tracewise-limit": limit, "retry-after": expect.stringMatching(/^\d+$/) });
		expect(JSON.parse(res.body!)).toEqual({ error });
		expect(tenants.secondsUntil).toHaveBeenCalledWith("2026-11-01");
		expect(send).not.toHaveBeenCalled();
		expect(tenants.releaseQuota).not.toHaveBeenCalled();
	});

	it("gives the counted events back when SQS refuses them", async () => {
		send.mockResolvedValue({ Failed: [{ Id: "0" }] } as never);
		const res = await handler(request({ events: [event(), event()] }));
		expect(res.statusCode).toBe(503);
		expect(tenants.releaseQuota).toHaveBeenCalledWith(tenant, 2);
	});

	it("gives the counted events back when SQS throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		send.mockRejectedValue(new Error("throttled"));
		const res = await handler(request({ events: [event(), event(), event()] }));
		expect(res.statusCode).toBe(503);
		expect(res.headers).toMatchObject({ "retry-after": "2" });
		expect(JSON.parse(res.body!)).toEqual({ error: "temporarily unable to accept events, retry" });
		expect(tenants.releaseQuota).toHaveBeenCalledWith(tenant, 3);
	});

	it("tells clients to wait a minute when the period has already ended", async () => {
		tenants.secondsUntil.mockReturnValueOnce(0);
		tenants.consumeQuota.mockResolvedValue("month");
		const res = await handler(request({ events: [event()] }));
		expect(res.statusCode).toBe(429);
		expect(res.headers).toMatchObject({ "retry-after": "60" });
	});

	it("does not release anything when the events were enqueued", async () => {
		await handler(request({ events: [event()] }));
		expect(tenants.releaseQuota).not.toHaveBeenCalled();
	});

	it("puts the tenant's retention on each queued event", async () => {
		tenants.tenantForKey.mockResolvedValue({ ...tenant, plan: "pro", retention_days: 90 });
		await handler(request({ events: [event()] }));
		const body = (send.mock.calls[0]![0] as { input: { Entries: { MessageBody: string }[] } }).input.Entries[0]!.MessageBody;
		expect(JSON.parse(body).retention_days).toBe(90);
	});

	it("stamps the key's last use after authenticating, and skips legacy tenants without a key id", async () => {
		await handler(request({ events: [event()] }));
		expect(accounts.touchKey).toHaveBeenCalledWith("tenant-1", "k1");
		accounts.touchKey.mockClear();
		tenants.tenantForKey.mockResolvedValue({ ...tenant, key_id: undefined });
		await handler(request({ events: [event()] }));
		expect(accounts.touchKey).not.toHaveBeenCalled();
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

	it("refuses to ingest with a read-only key", async () => {
		tenants.tenantForKey.mockResolvedValue({ ...tenant, scope: "read" });
		const res = await handler(request({ events: [event()] }));
		expect(res.statusCode).toBe(403);
		expect(send).not.toHaveBeenCalled();
	});
});
