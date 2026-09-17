import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { hashToken } from "../auth/token-store.js";
import { getApifyTokenRepo } from "../store/apify-token-repo.js";
import { logger } from "../utils/logger.js";
import { isSingleTenantMode, LOCAL_TENANT_ID, resolveTenantId } from "../auth/tenant.js";
import { BodyTooLargeError, readBodyWithLimit } from "../utils/bounded-body.js";
import type { ApifyErrorBody } from "./types.js";

/** Fixed on purpose: an env-overridable base URL would let a config change redirect tenant tokens to an attacker host. */
const APIFY_BASE_URL = "https://api.apify.com";
const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
/** A dataset page is at most a few MB; anything larger is not a response worth buffering. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function tooLarge(detail: string): McpError {
  return new McpError(ErrorCode.InternalError, `Apify response too large (${detail}; limit ${MAX_RESPONSE_BYTES} bytes). Request a smaller page.`);
}

/** Same budgeted read every outbound client uses; only the error is Apify-flavoured. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  try {
    return await readBodyWithLimit(response, maxBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw tooLarge(err.detail);
    throw err;
  }
}

/**
 * Empty bodies are failures where JSON is expected (204 is handled before
 * this): a null page would be cached as an empty dataset. Thrown as a plain
 * Error, not McpError, so execute() treats it like any other transport
 * failure — retried on GET, flagged as indeterminate on POST.
 */
function parseJsonBody(text: string): unknown {
  if (text.trim().length === 0) {
    throw new Error("Apify returned an empty body where JSON was expected.");
  }
  return JSON.parse(text);
}

export const ADS_LIBRARY_ACTOR_ID = "curious_coder~facebook-ads-library-scraper";

export { LOCAL_TENANT_ID };

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
 * Which encrypted-token bucket this request may read. Fails closed in
 * multi-tenant mode without an OAuth identity (see src/auth/tenant.ts): an
 * unidentified caller must never land on the shared `_local` bucket or the
 * server-wide APIFY_TOKEN and spend another tenant's Apify credit.
 */
export function resolveApifyTenantId(): string {
  return resolveTenantId({ feature: "ads_library_*" });
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
          const errorBody = await readBoundedBody(response, MAX_RESPONSE_BYTES)
            .then((text) => (text.trim().length === 0 ? null : (JSON.parse(text) as unknown)))
            .catch((err: unknown) => {
              if (err instanceof McpError && /too large/.test(err.message)) throw err;
              return null;
            });

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
        return parseJsonBody(await readBoundedBody(response, MAX_RESPONSE_BYTES)) as T;
      } catch (error) {
        // Any failure after the request left the client is indeterminate for a
        // non-retryable (billable) call, not just a timeout: Apify may have
        // accepted the run and then dropped the connection or returned a
        // truncated body. Callers must not read this as "safe to retry".
        const indeterminate = canRetry
          ? ""
          : " The request may still have been accepted — check ads_library_list_runs before starting another scrape.";

        if (error instanceof McpError) {
          // A body over the size cap is a transport-level failure too, and the run may have started.
          if (!canRetry && /too large/.test(error.message)) throw new McpError(error.code, error.message + indeterminate);
          throw error;
        }

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
