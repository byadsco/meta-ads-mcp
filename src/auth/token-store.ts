import { AsyncLocalStorage } from "node:async_hooks";

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
 * Falls back to META_ACCESS_TOKEN env var if no request context.
 */
export function getAccessToken(): string {
  const ctx = requestContext.getStore();
  if (ctx?.accessToken) {
    return ctx.accessToken;
  }

  const envToken = process.env.META_ACCESS_TOKEN;
  if (envToken) {
    return envToken;
  }

  throw new Error(
    "No Meta access token available. Provide via Authorization: Bearer <token> header or META_ACCESS_TOKEN env var.",
  );
}
