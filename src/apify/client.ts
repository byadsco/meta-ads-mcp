import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getCurrentFbUserId, hashToken } from "../auth/token-store.js";
import { getApifyTokenRepo } from "../store/apify-token-repo.js";
import { logger } from "../utils/logger.js";
import { isStdioTransport } from "../utils/transport-mode.js";
import type { ApifyErrorBody } from "./types.js";

/** Fixed on purpose: an env-overridable base URL would let a config change redirect tenant tokens to an attacker host. */
const APIFY_BASE_URL = "https://api.apify.com";
const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;

export const ADS_LIBRARY_ACTOR_ID = "curious_coder~facebook-ads-library-scraper";

/**
 * Storage key for stdio / single-operator mode, where there is no OAuth
 * request context. Facebook user ids are numeric, so this cannot collide with
 * a real tenant. It is only ever reachable via isSingleTenantMode().
 */
export const LOCAL_TENANT_ID = "_local";

const APIFY_TOKEN_PATTERN = /apify_api_[A-Za-z0-9]+/g;

/**
 * Belt-and-braces: Apify does not echo tokens in error bodies today, but a
 * malformed request could surface one, and these strings end up in McpError
 * messages that travel back to the MCP client.
 *
 * `exactToken` covers credentials that do not match the `apify_api_` shape —
 * legacy, future, or simply malformed values the pattern alone would miss.
 */
export function scrubApifyToken(text: string, exactToken?: string): string {
  if (!exactToken || exactToken.length < 8) {
    return text.replace(APIFY_TOKEN_PATTERN, "apify_api_[REDACTED]");
  }

  // Both alternatives must be considered in a single left-to-right pass.
  // Neither sequential order is safe: running the pattern first leaves the
  // tail of a hybrid value (`apify_api_abc-secret` → `…[REDACTED]-secret`),
  // while running the exact value first fragments a longer token that the
  // exact value happens to prefix (`apify_api_abc` inside `apify_api_abcdef`
  // → `[REDACTED]def`). Folding trailing base62 into the exact alternative
  // makes it swallow the whole credential either way.
  const combined = new RegExp(
    `${escapeRegExp(exactToken)}[A-Za-z0-9]*|apify_api_[A-Za-z0-9]+`,
    "g",
  );
  return text.replace(combined, (match) =>
    match.startsWith("apify_api_") ? "apify_api_[REDACTED]" : "[REDACTED]",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apify run/dataset/actor ids are 17-char base62. Validating keeps them out of the URL path as anything else. */
export function validateApifyId(id: string, label: string): string {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9]{5,32}$/.test(trimmed)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid Apify ${label} id "${trimmed}". Expected 5-32 alphanumeric characters.`,
    );
  }
  return trimmed;
}

/**
 * Shows only the non-secret `apify_api_` prefix. Deliberately reveals no
 * characters of the secret body — not even a suffix — since nothing downstream
 * needs to disambiguate between two tokens for the same user (there is only
 * ever one).
 */
export function maskApifyToken(token: string): string {
  return token.startsWith("apify_api_") ? "apify_api_***" : "***";
}

/**
 * Multi-tenant is on exactly when the Meta OAuth app is configured, mirroring
 * `metaAppConfigured` in src/transport/security-config.ts. Read directly from
 * env rather than calling resolveSecurityConfig(), which validates and can
 * throw — this runs on every request and must not turn a config problem into
 * an unrelated tool failure.
 */
function isSingleTenantMode(): boolean {
  if (isStdioTransport(process.argv)) return true;
  return !(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim());
}

/**
 * Which encrypted-token bucket this request may read.
 *
 * Fails closed: in multi-tenant HTTP mode an unidentified caller (API-key
 * mode, or any flow that loses the OAuth identity) must NOT silently land in
 * the shared `_local` bucket or on the server-wide APIFY_TOKEN — that would
 * let one tenant read another's credential and spend their Apify credit.
 */
export function resolveApifyTenantId(): string {
  const fbUserId = getCurrentFbUserId();
  if (fbUserId) return fbUserId;

  if (isSingleTenantMode()) return LOCAL_TENANT_ID;

  throw new McpError(
    ErrorCode.InvalidRequest,
    "The ads_library_* tools need an authenticated user in multi-tenant mode. Sign in through the Meta OAuth flow — API-key requests have no tenant identity, so no Apify token can be resolved for them.",
  );
}

/**
 * Whether the server-wide APIFY_TOKEN would actually be used for this request.
 * Reporting "an env token exists" without this check misleads a multi-tenant
 * caller into thinking they are covered when resolveApifyToken() will refuse.
 */
export function isApifyEnvFallbackUsable(): boolean {
  return Boolean(process.env.APIFY_TOKEN?.trim()) && isSingleTenantMode();
}

/**
 * Per-tenant encrypted token first. The server-wide APIFY_TOKEN is only
 * honoured in single-tenant mode; sharing it across OAuth tenants would bill
 * one advertiser's scrapes to the operator's Apify account.
 */
export async function resolveApifyToken(): Promise<string> {
  const tenantId = resolveApifyTenantId();
  const stored = await getApifyTokenRepo().getDecryptedToken(tenantId);
  if (stored) return stored;

  if (tenantId === LOCAL_TENANT_ID) {
    const envToken = process.env.APIFY_TOKEN?.trim();
    if (envToken) return envToken;
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    "No Apify token registered for this user. Register one on the /auth/connections page, or with ads_library_register_apify_token.",
  );
}

function isApifyErrorBody(body: unknown): body is ApifyErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ApifyErrorBody).error === "object"
  );
}

function describeApifyError(body: unknown, status: number, exactToken?: string): string {
  if (isApifyErrorBody(body)) {
    const { type, message } = body.error;
    return scrubApifyToken(`${type ?? "error"}: ${message ?? "(no message)"}`, exactToken);
  }
  return `HTTP ${status}`;
}

function toMcpError(
  status: number,
  body: unknown,
  retryAfter: string | null,
  exactToken?: string,
): McpError {
  const detail = describeApifyError(body, status, exactToken);

  switch (status) {
    case 400:
      return new McpError(ErrorCode.InvalidParams, `Apify rejected the request — ${detail}`);
    case 401:
    case 403:
      return new McpError(
        ErrorCode.InvalidRequest,
        `Apify authentication failed — ${detail}. Re-register your token on the /auth/connections page, or with ads_library_register_apify_token.`,
      );
    case 402:
      return new McpError(
        ErrorCode.InvalidRequest,
        `Apify refused the run for billing reasons — ${detail}. Check your credits at console.apify.com/billing.`,
      );
    case 404:
      return new McpError(ErrorCode.InvalidParams, `Apify resource not found — ${detail}`);
    case 429:
      return new McpError(
        ErrorCode.InvalidRequest,
        `Apify rate limit exceeded — ${detail}.${retryAfter ? ` Retry after ${retryAfter}s.` : ""}`,
      );
    default:
      return new McpError(
        status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest,
        `Apify request failed (HTTP ${status}) — ${detail}`,
      );
  }
}

export interface ApifyRequestParams {
  [key: string]: string | number | boolean | undefined;
}

export class ApifyApiClient {
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config?: { timeout?: number; maxRetries?: number }) {
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
  }

  async get<T>(path: string, params?: ApifyRequestParams, tokenOverride?: string): Promise<T> {
    return this.execute<T>("GET", path, params, undefined, tokenOverride, true);
  }

  /**
   * Never retried: starting an actor run costs real money, so a retried
   * timeout could mint (and bill for) a duplicate scrape.
   */
  async post<T>(
    path: string,
    body?: unknown,
    params?: ApifyRequestParams,
    tokenOverride?: string,
  ): Promise<T> {
    return this.execute<T>("POST", path, params, body, tokenOverride, false);
  }

  async delete<T>(path: string, params?: ApifyRequestParams, tokenOverride?: string): Promise<T> {
    return this.execute<T>("DELETE", path, params, undefined, tokenOverride, false);
  }

  private buildUrl(path: string, params?: ApifyRequestParams): string {
    const url = new URL(`${APIFY_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async execute<T>(
    method: string,
    path: string,
    params: ApifyRequestParams | undefined,
    body: unknown,
    tokenOverride: string | undefined,
    canRetry: boolean,
  ): Promise<T> {
    const token = tokenOverride ?? (await resolveApifyToken());
    const tokenHash = hashToken(token);
    const url = this.buildUrl(path, params);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method,
          // Bearer header, never a query param — keeps the token out of every
          // URL that could be logged or embedded in an error message.
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });

        // NB: the abort timer is deliberately still armed here. A server can
        // send headers and then stall mid-body forever; clearing the timeout
        // at header time would hang the call and hold the connection open.
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);

          if (response.status >= 500 && canRetry && attempt < this.maxRetries) {
            lastError = toMcpError(response.status, errorBody, null, token);
            await this.backoff(attempt);
            continue;
          }

          logger.warn(
            {
              event: "apify_error",
              path,
              status: response.status,
              apifyErrorType: isApifyErrorBody(errorBody) ? errorBody.error.type : undefined,
              tokenHash,
            },
            "Apify request failed",
          );
          throw toMcpError(
            response.status,
            errorBody,
            response.headers.get("retry-after"),
            token,
          );
        }

        // Apify returns 204 with no body for some endpoints (e.g. deletes).
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof McpError) throw error;

        // Any failure after the request left the client is indeterminate for a
        // non-retryable (billable) call, not just a timeout: Apify may have
        // accepted the run and then dropped the connection or returned a
        // truncated body. Callers must not read this as "safe to retry".
        const indeterminate = canRetry
          ? ""
          : " The request may still have been accepted — check ads_library_list_runs before starting another scrape.";

        if (error instanceof Error && error.name === "AbortError") {
          lastError = new McpError(
            ErrorCode.InternalError,
            `Apify request timed out after ${this.timeout}ms.${indeterminate}`,
          );
        } else {
          lastError = new McpError(
            ErrorCode.InternalError,
            scrubApifyToken(
              `Apify request failed: ${error instanceof Error ? error.message : String(error)}`,
              token,
            ) + indeterminate,
          );
        }

        if (canRetry && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    logger.error({ event: "apify_retries_exhausted", path, tokenHash }, "All Apify retries exhausted");
    throw lastError ?? new McpError(ErrorCode.InternalError, "Apify request failed after retries");
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
    const jitter = delay * (Math.random() * 0.4 - 0.2);
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
  }
}

export const apifyApiClient = new ApifyApiClient();
