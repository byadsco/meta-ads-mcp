import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isStdioTransport } from "../utils/transport-mode.js";
import { getCurrentFbUserId } from "./token-store.js";

/**
 * Storage key for stdio / single-operator mode, where there is no OAuth
 * request context. Facebook user ids are numeric, so this cannot collide with
 * a real tenant. It is only ever reachable via isSingleTenantMode().
 */
export const LOCAL_TENANT_ID = "_local";

/**
 * Reads the env directly rather than resolveSecurityConfig(), which can
 * throw — this runs on every request and must not turn a config problem into
 * an unrelated tool failure.
 */
export function isSingleTenantMode(argv: readonly string[] = process.argv): boolean {
  if (isStdioTransport(argv)) return true;
  return !(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim());
}

/**
 * Which per-tenant bucket (encrypted credentials, rate limits) this request may use.
 *
 * Fails closed: in multi-tenant HTTP mode an unidentified caller (API-key
 * mode, or any flow that loses the OAuth identity) must NOT silently land in
 * the shared `_local` bucket or on a server-wide fallback credential — that
 * would let one tenant read another's credential or spend their quota.
 */
export function resolveTenantId(options: { feature: string; argv?: readonly string[] }): string {
  const fbUserId = getCurrentFbUserId();
  if (fbUserId) return fbUserId;

  if (isSingleTenantMode(options.argv)) return LOCAL_TENANT_ID;

  throw new McpError(
    ErrorCode.InvalidRequest,
    `The ${options.feature} tools need an authenticated user in multi-tenant mode. Sign in through the Meta OAuth flow — API-key requests have no tenant identity, so no per-user credential or quota can be resolved for them.`,
  );
}
