import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { tokenManager } from "./token-manager.js";

export interface RequestContext {
  accessToken: string;
  fbUserId?: string;
}

/**
 * AsyncLocalStorage to thread the Meta access token from the Express
 * middleware through to the MetaApiClient without passing it explicitly.
 *
 * In multi-tenant HTTP mode the middleware resolves the token from
 * Firestore (decrypting + auto-refreshing if needed) and stores the
 * plaintext here together with the fbUserId and tokenName.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request's access token.
 *
 * Priority:
 *  1. AsyncLocalStorage context (per-request, set by HTTP middleware)
 *  2. TokenManager active token (multi-token registry / legacy)
 *  3. META_ACCESS_TOKEN env var (legacy fallback)
 */
export function getAccessToken(): string {
  const ctx = requestContext.getStore();
  if (ctx?.accessToken) {
    return ctx.accessToken;
  }

  const managerToken = tokenManager.getActiveToken();
  if (managerToken) {
    return managerToken;
  }

  const envToken = process.env.META_ACCESS_TOKEN;
  if (envToken) {
    return envToken;
  }

  throw new Error(
    "No Meta access token available. Connect via Meta OAuth, register a token, or set META_ACCESS_TOKEN.",
  );
}

export function getCurrentFbUserId(): string | undefined {
  return requestContext.getStore()?.fbUserId;
}

/**
 * Short, stable, non-reversible identifier for the currently active access token.
 *
 * Used as a bucket key for rate-limit and circuit-breaker state so we never
 * log or serialize the raw token. SHA-256 truncated to 12 hex chars ≈ 48 bits
 * of entropy — enough to avoid collisions across an agency's handful of tokens.
 */
export function getAccessTokenHash(): string {
  const token = getAccessToken();
  return hashToken(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Hash personally-identifying values (email, fbUserId, etc.) before
 * including them in log lines (CODE-B5). The output is a stable
 * 12-hex-char prefix of SHA-256 — enough to correlate events from the
 * same user without storing the raw value in our log retention.
 *
 * Returns null if input is null/undefined so callers can pass through
 * optional fields without conditional clutter:
 *
 *   logger.warn({ user: hashPii(profile.email) }, "rejected by allowlist");
 */
export function hashPii(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
