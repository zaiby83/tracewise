// The console's API client. Every call carries the ID token; a 401 gets one forced
// token refresh and one retry before it surfaces as an AuthError (sign in again).

export class AuthError extends Error {
	constructor(message = "Your session has expired. Sign in again.") {
		super(message);
		this.name = "AuthError";
	}
}

// The API's error bodies are { error, limit? }; API Gateway's own 401 and 403 use { message }, hence the fallback.
export function messageFor(status, body) {
	if (status === 404) return "Not found, or you don't have access.";
	if (status === 409 && body?.limit) return `You've reached your plan's limit (${body.limit}).`;
	if (status === 429 && body?.error) return body.error;
	return body?.error ?? `Something went wrong (HTTP ${status}).`;
}

export function createApi({ getToken, fetch = globalThis.fetch }) {
	async function request(method, path, body) {
		const send = (token) =>
			fetch(path, {
				method,
				headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
			});

		let token = await getToken();
		if (!token) throw new AuthError();
		let res = await send(token);
		if (res.status === 401) {
			token = await getToken({ force: true });
			if (!token) throw new AuthError();
			res = await send(token);
			if (res.status === 401) throw new AuthError();
		}
		const parsed = await res.json().catch(() => ({}));
		if (!res.ok) throw Object.assign(new Error(messageFor(res.status, parsed)), { status: res.status });
		return parsed;
	}

	return {
		get: (path) => request("GET", path),
		post: (path, body) => request("POST", path, body),
		patch: (path, body) => request("PATCH", path, body),
		del: (path, body) => request("DELETE", path, body),
	};
}
