import { AsyncLocalStorage } from "node:async_hooks";
import { tokenManager } from "./token-manager.js";

export interface RequestContext {
  accessToken: string;
}

/**
 * AsyncLocalStorage to thread the Meta access token from the Express
 * middleware through to the MetaApiClient without passing it explicitly.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request's access token.
 *
 * Priority:
 *  1. AsyncLocalStorage context (per-request, set by HTTP middleware)
 *  2. TokenManager active token (multi-token registry)
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
    "No Meta access token available. Provide via X-Meta-Token header, META_TOKENS env var, or META_ACCESS_TOKEN env var.",
  );
}
