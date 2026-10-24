export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:3000/api/v1";

export async function request(path, { token, baseUrl=API_BASE_URL, timeout=15000, ...options } = {}) {
	let response;
	try { response = await fetch(`${baseUrl}${path}`, {
		...options,
		signal:AbortSignal.timeout(timeout),
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...options.headers,
		},
	}); }catch(error){throw Object.assign(new Error(error.name==="TimeoutError"||error.name==="AbortError"?"request_timeout":"connection_failed"),{uncertain:true});}

	let body;
	try{body=await response.json();}catch{if(response.ok)throw Object.assign(new Error("connection_failed"),{uncertain:true});body={};}
	if (!response.ok) {
		const error = new Error(body.error || `API request failed (${response.status})`);
		error.status = response.status;
		error.details = body.details;
		error.uncertain=response.status>=500;
		throw error;
	}

	return body;
}

export function registerOrganization(payload) {
	return request("/auth/register", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function loginOrganization(payload) {
	return request("/auth/login", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function pushSyncEvents(token, changes) {
	return request("/sync/push", {
		method: "POST",
		token,
		body: JSON.stringify({ changes }),
	});
}

export function pullSyncEvents(token, cursor) {
	const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
	return request(`/sync/pull${query}`, { token });
}
