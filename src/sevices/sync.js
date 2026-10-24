import { API_BASE_URL, pushSyncEvents } from "./api";
import {
  getPendingSyncEvents,
  markSyncEventsCompleted,
} from "./database";

const TOKEN_KEY = "sm_api_token";
const TOKEN_EXPIRY_KEY = "sm_api_token_expiry";

function storeToken(token, expiresAt) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
  if (expiresAt) {
    localStorage.setItem(TOKEN_EXPIRY_KEY, String(expiresAt));
  } else {
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  }
}

function getStoredToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
  if (!token || !expiry) return null;
  if (Date.now() > Number(expiry)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
    return null;
  }
  return token;
}

export async function signInToApi({ organizationId, phone, password }) {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId, phone, password }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "API request failed");
    error.status = response.status;
    error.details = body.details;
    throw error;
  }

  const { token, ...rest } = body;
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  storeToken(token, expiresAt);

  return { token, ...rest };
}

async function requestWithRetry({ url, options, retries = 5, backoff = 1000 }) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const {token,...fetchOptions}=options||{};
      const response = await fetch(url, {
        ...fetchOptions,
        headers: {
          "Content-Type": "application/json",
          ...(options?.headers ?? {}),
          ...(token?{Authorization:`Bearer ${token}`} :{}),
        },
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || `API request failed (${response.status})`);
        error.status = response.status;
        error.details = body.details;
        if (response.status >= 500 && attempt < retries) {
          throw error;
        }
        throw error;
      }

      return body;
    } catch (error) {
      lastError = error;
      if (error.status < 500 || attempt >= retries) throw error;
      const delay = backoff * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export async function pullSyncEvents(cursor) {
  const token = getStoredToken();
  if (!token) throw new Error("authentication_required");

  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const body = await requestWithRetry({
    url: `${API_BASE_URL}/sync/pull${query}`,
    options: { method: "GET", token },
  });

  return {
    changes: body.changes || [],
    nextCursor: body.nextCursor || null,
  };
}

export async function syncPendingChanges({ databasePath, token, pullOnFailure = false }) {
  if (!databasePath) throw new Error("database_path_required");
  if (!token) {
    const stored = getStoredToken();
    if (!stored) throw new Error("authentication_required");
    token = stored;
  }

  const pendingEvents = await getPendingSyncEvents(databasePath);
  if (pendingEvents.length === 0) {
    return { sent: 0, remaining: 0 };
  }

  const response = await pushSyncEvents(token, pendingEvents);
  const acceptedEventIds = response.results
    .filter(({ status }) => status === "accepted" || status === "already_received")
    .map(({ eventId }) => eventId);

  if (acceptedEventIds.length > 0) {
    await markSyncEventsCompleted(databasePath, acceptedEventIds);
  }

  return {
    sent: acceptedEventIds.length,
    remaining: pendingEvents.length - acceptedEventIds.length,
  };
}
