export interface TraceInput {
	model: string;
	input: string;
	output: string;
	latency_ms: number;
	provider?: string;
	route?: string;
	status?: "ok" | "error";
	tokens_in?: number;
	tokens_out?: number;
	cost_usd?: number;
	security?: { verdict: string; rules: string[] };
	metadata?: Record<string, string>;
}

export interface TracewiseOptions {
	apiKey: string;
	endpoint: string;
	// Send when this many events are buffered, or after flushIntervalMs, whichever is first.
	maxBatch?: number;
	flushIntervalMs?: number;
	// Upper bound on buffered events while the service is unreachable; the oldest are
	// dropped beyond it, so memory stays bounded.
	maxBuffer?: number;
	maxRetries?: number;
	// Runs on each event before it leaves the process: strip anything sensitive here.
	redact?: (event: TraceInput) => TraceInput;
	fetch?: typeof fetch;
	onError?: (err: unknown) => void;
}

const MAX_FIELD_CHARS = 30_000;

// Buffers trace events and ships them in batches, in the background. Nothing here
// throws into the caller or blocks a model call: if Tracewise is down, events are
// retried and eventually dropped, and the application never notices.
export class Tracewise {
	private buffer: object[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight = new Set<Promise<void>>();
	private readonly opts: Required<Omit<TracewiseOptions, "redact" | "onError">> & Pick<TracewiseOptions, "redact" | "onError">;
	dropped = 0;

	constructor(options: TracewiseOptions) {
		this.opts = {
			maxBatch: 50,
			flushIntervalMs: 2000,
			maxBuffer: 10_000,
			maxRetries: 5,
			fetch: globalThis.fetch.bind(globalThis),
			...options,
			endpoint: options.endpoint.replace(/\/+$/, ""),
		};
		this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
		// Don't keep a Node process alive just to flush.
		(this.timer as { unref?: () => void }).unref?.();
	}

	record(trace: TraceInput): void {
		try {
			const t = this.opts.redact ? this.opts.redact(trace) : trace;
			this.buffer.push({
				...t,
				input: t.input.slice(0, MAX_FIELD_CHARS),
				output: t.output.slice(0, MAX_FIELD_CHARS),
				latency_ms: Math.round(t.latency_ms),
				event_id: crypto.randomUUID(),
				ts: new Date().toISOString(),
			});
			if (this.buffer.length > this.opts.maxBuffer) {
				const excess = this.buffer.length - this.opts.maxBuffer;
				this.buffer.splice(0, excess);
				this.dropped += excess;
			}
			if (this.buffer.length >= this.opts.maxBatch) void this.flush();
		} catch (err) {
			this.opts.onError?.(err);
		}
	}

	// Wraps a model call: times it, records it, and returns its result untouched.
	async trace<T>(
		meta: Omit<TraceInput, "output" | "latency_ms" | "status"> & { output?: (result: T) => string },
		call: () => Promise<T>,
	): Promise<T> {
		const started = performance.now();
		try {
			const result = await call();
			const { output, ...rest } = meta;
			this.record({ ...rest, output: output ? output(result) : String(result), latency_ms: performance.now() - started });
			return result;
		} catch (err) {
			const { output: _, ...rest } = meta;
			this.record({ ...rest, output: String(err), status: "error", latency_ms: performance.now() - started });
			throw err;
		}
	}

	flush(): Promise<void> {
		if (this.buffer.length === 0) return Promise.all(this.inFlight).then(() => undefined);
		const batches: object[][] = [];
		while (this.buffer.length) batches.push(this.buffer.splice(0, Math.min(this.opts.maxBatch, 100)));
		const sends = batches.map((batch) => {
			const p = this.send(batch).finally(() => this.inFlight.delete(p));
			this.inFlight.add(p);
			return p;
		});
		return Promise.all(sends).then(() => undefined);
	}

	// Flushes what's buffered and stops the timer. Call before a process or Lambda exits.
	async shutdown(): Promise<void> {
		clearInterval(this.timer);
		await this.flush();
		await Promise.all(this.inFlight);
	}

	private async send(batch: object[]): Promise<void> {
		for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
			try {
				const res = await this.opts.fetch(`${this.opts.endpoint}/v1/traces`, {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
					body: JSON.stringify({ events: batch }),
				});
				if (res.ok) return;
				// 4xx other than 429 won't succeed on retry: bad key or bad data.
				if (res.status !== 429 && res.status < 500) {
					this.dropped += batch.length;
					this.opts.onError?.(new Error(`Tracewise rejected batch: HTTP ${res.status}`));
					return;
				}
			} catch (err) {
				if (attempt === this.opts.maxRetries) this.opts.onError?.(err);
			}
			// Exponential backoff with full jitter, so many clients don't retry in lockstep.
			await new Promise((r) => setTimeout(r, Math.random() * Math.min(30_000, 250 * 2 ** attempt)));
		}
		this.dropped += batch.length;
	}
}
