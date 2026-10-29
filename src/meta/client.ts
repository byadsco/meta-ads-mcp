import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getAccessToken, hashToken } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { RateLimiter, type RequestContext } from "./rate-limiter.js";
import { CircuitBreaker, type CircuitContext } from "./circuit-breaker.js";
import { WritePacer } from "./write-pacer.js";
import {
  classifyMetaError,
  isMetaApiError,
  type MetaErrorClassification,
} from "./errors.js";
import type { MetaApiError, MetaApiResponse } from "./types/common.js";
import { collectAllPages } from "./paginator.js";
import { assertMetaApiVersion, resolveMetaApiVersion } from "./api-version.js";
import { scrubCredentialsDeep, scrubErrorCredentials } from "../utils/scrub-credentials.js";

// An error answer can quote the request, its token included (a Page token
// while a Page action runs). It is cleaned before anything classifies, logs
// or returns it.
const withoutToken = scrubCredentialsDeep;

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const USAGE_LOG_INTERVAL_MS = 60_000;
const VERSION_WARNING_LOG_INTERVAL_MS = 60 * 60_000;

export interface MetaApiClientConfig {
  apiVersion?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

interface RequestScope {
  accountId?: string;
  // A call with a hard end, for work that has to fit a deadline: it is never
  // retried, it is not sent at all if pacing would hold it past this many
  // milliseconds, and it gives up on an answer that takes longer.
  timeoutMs?: number;
  // Sent once. A retried write whose first answer was lost can come back
  // refused, which would read as "nothing was written" when it may have been.
  noRetry?: boolean;
  // The request carries personal data, which Meta's error text can quote:
  // only Meta's code and subcode are logged and returned.
  withholdMessage?: boolean;
}

// An error whose text was written here, with nothing of the request or the
// answer in it.
class WithheldError extends Error {}

// Keeps only what cannot quote the request: Meta's code and subcode.
function withheld(error: MetaApiError): MetaApiError {
  const code = Number.isInteger(error.code) ? error.code : 0;
  const subcode = Number.isInteger(error.error_subcode) ? error.error_subcode : undefined;
  return {
    code,
    error_subcode: subcode,
    type: "",
    message: `code ${code}${subcode !== undefined ? `, subcode ${subcode}` : ""}; Meta's text is withheld because the request carried personal data`,
  };
}

// Rejects with `late()` once `until` passes, unless `work` settles first.
async function settleBy<T>(work: Promise<T>, until: number, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), Math.max(0, until - Date.now()));
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Typed client for the Meta Graph API.
 *
 * Compliance guarantees (see src/meta/errors.ts and rate-limiter.ts for
 * references to Meta's docs):
 *  - Bucketed rate-limiting per (token, ad-account, use-case type) — one hot
 *    account does not slow down the rest of the agency.
 *  - Circuit breaker halts requests to a bucket on abuse signals
 *    (subcode 1996), temporary user/business blocks, or repeated throttle.
 *  - Platform/BUC rate-limit errors (4, 17, 32, 613, 80000-80014) are NEVER
 *    retried inside the same request — Meta's docs explicitly warn that
 *    continuing to call after a throttle extends `estimated_time_to_regain_access`.
 *  - Write operations (POST/DELETE) are paced by a preventive token bucket
 *    sized to the Ads Management hourly quota.
 *  - Every response's rate-limit headers update per-bucket state for future
 *    self-throttling decisions.
 */
export class MetaApiClient {
  readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly rateLimiter = new RateLimiter();
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly writePacer = new WritePacer();
  private lastUsageLogAt = 0;
  private lastVersionWarningAt = 0;

  constructor(config?: MetaApiClientConfig) {
    this.apiVersion = assertMetaApiVersion(config?.apiVersion ?? resolveMetaApiVersion());
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    scope?: RequestScope,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.execute<T>("GET", url, path, undefined, false, scope);
  }

  async post<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildUrl(path);
    return this.execute<T>("POST", url, path, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async postForm<T>(
    path: string,
    params: Record<string, string | number | boolean>,
    scope?: RequestScope,
  ): Promise<T> {
    const url = this.buildUrl(path);
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      formBody.set(key, String(value));
    }
    return this.execute<T>("POST", url, path, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    }, false, scope);
  }

  async postMultipart<T>(
    path: string,
    formData: FormData,
  ): Promise<T> {
    const url = this.buildUrl(path);
    const token = getAccessToken();
    formData.set("access_token", token);
    return this.execute<T>("POST", url, path, { body: formData }, true);
  }

  async delete<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    scope?: RequestScope,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.execute<T>("DELETE", url, path, undefined, false, scope);
  }

  async getPaginated<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    maxItems = 1000,
  ): Promise<T[]> {
    const firstPage = await this.get<MetaApiResponse<T>>(path, params);
    if (!firstPage.data) return [];
    return collectAllPages<T>(
      firstPage,
      async (after) =>
        this.get<MetaApiResponse<T>>(path, { ...params, after }),
      maxItems,
    );
  }

  /**
   * One GET kept apart from everything this client shares between requests,
   * for a read that only words a result. Nothing it receives reaches the rate
   * limiter, the write pacer or the circuit breaker, and it is never retried,
   * so it cannot change what a later request does. It reads that state only
   * to abstain: with the circuit open, or while the limiter would wait, it
   * resolves to undefined without calling Meta. Any failure is undefined too.
   * The caller owns the deadline: aborting `signal` cancels the body as well.
   * The caller also names the token. This method never asks for the current
   * one: where the active token is process-wide it can change between two
   * awaits, and a caller that keys what it learns by token must be the one
   * to fix it.
   */
  async getDetached<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    signal: AbortSignal,
    token: string,
  ): Promise<T | undefined> {
    const tokenHash = hashToken(token);
    const accountId = extractAccountId(path);
    if (this.circuitBreaker.isOpen({ tokenHash, accountId, type: guessBucType("GET", path) })) return undefined;
    if (this.rateLimiter.getThrottleDelay({ tokenHash, accountId }) > 0) return undefined;

    const response = await fetch(this.appendToken(this.buildUrl(path, params), token), { method: "GET", signal });
    const body = (await response.json()) as unknown;
    if (!response.ok || isMetaApiError(body)) return undefined;
    return body as T;
  }

  /** The whole process's state, every tenant's: for tests and the logs. */
  getUsageSnapshot() {
    return {
      usage: this.rateLimiter.snapshot(),
      circuits: this.circuitBreaker.snapshot(),
      writePacer: this.writePacer.snapshot(),
    };
  }

  /**
   * One token's state, for the `ads_rate_status` tool. Every key carries the
   * token hash in a fixed position: `kind:token:…` for usage buckets,
   * `token:…` for circuits and write-pacer buckets.
   */
  getUsageSnapshotFor(tokenHash: string) {
    const { usage, circuits, writePacer } = this.getUsageSnapshot();
    return {
      usage: usage.filter((b) => b.key.split(":")[1] === tokenHash),
      circuits: circuits.filter((c) => c.key.split(":")[0] === tokenHash),
      writePacer: writePacer.filter((w) => w.key.split(":")[0] === tokenHash),
    };
  }

  resetForTests(): void {
    this.rateLimiter.reset();
    this.circuitBreaker.reset();
    this.writePacer.reset();
    this.lastUsageLogAt = 0;
    this.lastVersionWarningAt = 0;
  }

  // ─── Internal ────────────────────────────────────────────────

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const base = `${this.baseUrl}/${this.apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
    const url = new URL(base);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async execute<T>(
    method: string,
    url: string,
    path: string,
    options?: RequestInit,
    skipTokenParam = false,
    scope?: RequestScope,
  ): Promise<T> {
    const token = getAccessToken();
    const tokenHash = hashToken(token);
    const accountId = scope?.accountId ?? extractAccountId(path);
    const context: RequestContext = { tokenHash, accountId };
    const circuitContext: CircuitContext = {
      tokenHash,
      accountId,
      type: guessBucType(method, path),
    };

    // Circuit breaker is the hard stop: if open, never call Meta.
    this.circuitBreaker.assertClosed(circuitContext);

    const endBy = scope?.timeoutMs !== undefined ? Date.now() + scope.timeoutMs : undefined;
    // A bounded call that pacing would hold too long is not sent: Meta never
    // sees it, so it is reported as refused, not as an unknown outcome.
    const beforeSending = (wait: Promise<void>) => endBy === undefined
      ? wait
      : settleBy(wait, endBy, () => new McpError(ErrorCode.InvalidRequest, `Not sent: ${method} ${path} would have waited on rate limits past its ${scope?.timeoutMs} ms limit.`));

    // Preventive write pacing for POST / DELETE on account-scoped paths.
    const isWrite =
      (method === "POST" || method === "DELETE") &&
      accountId !== undefined;
    if (isWrite) {
      await beforeSending(this.writePacer.acquire(tokenHash, accountId));
    }

    // Reactive self-throttle based on last-known usage headers.
    await beforeSending(this.rateLimiter.waitIfNeeded(context));

    const reqUrl = skipTokenParam ? url : this.appendToken(url, token);

    // POST to /act_<id>/<collection> creates new resources without native
    // idempotency on Meta's side — retrying a timeout/5xx/network error can
    // mint duplicates (e.g. two ad sets for one user intent). The /<id>/copies
    // edge (ad/ad set/campaign duplication) creates a resource on a non-act_
    // path, so it must be classed as creating too — otherwise a retried copy
    // mints a duplicate ad. The WhatsApp creating edges live on plain-numeric
    // WABA/phone paths: /message_templates, /flows, /message_qrdls create
    // resources, and /request_code sends a real SMS/voice call — all mint
    // duplicates on retry. A Page's /leadgen_forms creates a lead form the
    // same way. Other POSTs (updates on /<id>) and DELETEs are idempotent at
    // the API level.
    const isCreatingRequest =
      method === "POST" &&
      (/^\/?act_[A-Za-z0-9]+\//.test(path) ||
        /\/copies$/.test(path) ||
        /\/(message_templates|flows|message_qrdls|request_code|leadgen_forms|ad_studies)$/.test(path));
    const canRetryTransport = !isCreatingRequest;
    const maxRetries = endBy === undefined && !scope?.noRetry ? this.maxRetries : 0;
    const timeout = endBy === undefined ? this.timeout : Math.max(1, endBy - Date.now());

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          timeout,
        );

        const response = await fetch(reqUrl, {
          method,
          ...options,
          signal: controller.signal,
        });

        // A bounded call keeps its abort armed until the answer is read.
        if (endBy === undefined) clearTimeout(timeoutId);

        // Update rate-limiter + pacer from response headers — regardless of
        // whether the response was OK. Throttle signals travel on error
        // responses too.
        this.rateLimiter.updateFromHeaders(response.headers, context);
        this.maybeUpdatePacerTierFromHeaders(response.headers, tokenHash, accountId);
        this.maybeLogUsage();
        // Header text is not logged for a call that carries personal data.
        if (!scope?.withholdMessage) this.maybeLogVersionWarning(response.headers, token);

        // A bounded call's limit covers reading the answer too, and running
        // out of it cancels the transfer.
        let body: unknown;
        try {
          body = endBy === undefined
            ? await response.json()
            : await settleBy(response.json() as Promise<unknown>, endBy, () => {
              controller.abort();
              return new Error(`Request timeout after ${scope?.timeoutMs}ms`);
            });
        } finally {
          clearTimeout(timeoutId);
        }

        if (isMetaApiError(body)) {
          const metaError = scope?.withholdMessage ? withheld(body.error) : withoutToken(body.error, token);
          const classification = classifyMetaError(metaError);
          this.logMetaError(metaError, classification, context, path);

          if (classification.throttled) {
            // Seed the rate-limiter with the retry-after hint so sibling
            // requests back off even before the next header arrives.
            if (classification.retryAfterMs) {
              this.rateLimiter.markRetryAfter(
                context,
                circuitContext.type ?? "unknown",
                classification.retryAfterMs,
              );
            }
            this.circuitBreaker.trip(circuitContext, classification);
            // Meta's doc: "If you reach the limit, stop making API calls."
            throw classification.mcpError;
          }

          if (classification.retryable && canRetryTransport && attempt < maxRetries) {
            lastError = classification.mcpError;
            await this.backoff(attempt);
            continue;
          }

          throw classification.mcpError;
        }

        if (!response.ok) {
          lastError = scope?.withholdMessage
            ? new WithheldError(`HTTP ${response.status} (the answer is withheld: the request carried personal data)`)
            : new Error(`HTTP ${response.status}: ${JSON.stringify(withoutToken(body, token))}`);
          if (response.status >= 500 && canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        return body as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeout}ms`);
          if (canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Anything not written here may quote the request or the answer: the
        // JSON parser's message quotes the body it could not read.
        if (scope?.withholdMessage && !(error instanceof McpError) && !(error instanceof WithheldError)) {
          const kind = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
          lastError = new WithheldError(`${kind} on ${method} ${path}; its text is withheld because the request carried personal data`);
          if (canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Already-classified errors bubble up unchanged, but a transport
        // error with a code is not one of them, and may quote the request.
        if (error instanceof Error && "code" in error) {
          throw scrubErrorCredentials(error, token);
        }

        lastError = error instanceof Error ? scrubErrorCredentials(error, token) : new Error(withoutToken(String(error), token));
        if (canRetryTransport && attempt < maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }
    }

    logger.error({ error: lastError, path }, "All retries exhausted");
    throw lastError ?? new Error("Request failed after retries");
  }

  private appendToken(url: string, token: string): string {
    const u = new URL(url);
    u.searchParams.set("access_token", token);
    return u.toString();
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
    const jitter = delay * (Math.random() * 0.4 - 0.2); // ±20%
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
  }

  private maybeUpdatePacerTierFromHeaders(
    headers: Headers,
    tokenHash: string,
    accountId: string | undefined,
  ): void {
    if (!accountId) return;
    const throttle = headers.get("x-fb-ads-insights-throttle");
    if (throttle) {
      try {
        const parsed = JSON.parse(throttle) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
    const acc = headers.get("x-ad-account-usage");
    if (acc) {
      try {
        const parsed = JSON.parse(acc) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private logMetaError(
    error: { code: number; error_subcode?: number; message: string; fbtrace_id?: string },
    classification: MetaErrorClassification,
    context: RequestContext,
    path: string,
  ): void {
    const payload = {
      event: "meta_error",
      path,
      meta_error_code: error.code,
      meta_subcode: error.error_subcode,
      fbtrace_id: error.fbtrace_id,
      category: classification.category,
      throttled: classification.throttled,
      retryAfterMs: classification.retryAfterMs,
      tokenHash: context.tokenHash,
      accountId: context.accountId,
    };
    if (classification.critical) {
      logger.fatal(payload, error.message);
    } else if (
      classification.category === "invalid_params" ||
      classification.category === "duplicate"
    ) {
      // 4xx user-side — count as user_errors signal (Insights formula subtracts
      // 0.001 × user_errors from hourly quota).
      logger.warn({ ...payload, event: "meta_user_error" }, error.message);
    } else {
      logger.error(payload, error.message);
    }
  }

  // Meta answers calls on a retired Marketing API version by upgrading the
  // endpoints that did not change and rejecting the ones that did. The header
  // only arrives once the version is gone, so it means the pin is already
  // overdue rather than about to be.
  private maybeLogVersionWarning(headers: Headers, token: string): void {
    const raw = headers.get("x-ad-api-version-warning");
    if (!raw) return;
    const warning = withoutToken(raw, token);
    const now = Date.now();
    if (now - this.lastVersionWarningAt < VERSION_WARNING_LOG_INTERVAL_MS) return;
    this.lastVersionWarningAt = now;
    logger.warn(
      { event: "meta_api_version_auto_upgraded", apiVersion: this.apiVersion },
      `Meta auto-upgraded a call because ${this.apiVersion} is deprecated: bump DEFAULT_META_API_VERSION in src/meta/api-version.ts. Meta said: ${warning}`,
    );
  }

  private maybeLogUsage(): void {
    const now = Date.now();
    if (now - this.lastUsageLogAt < USAGE_LOG_INTERVAL_MS) return;
    this.lastUsageLogAt = now;
    const snapshot = this.rateLimiter.snapshot();
    if (snapshot.length === 0) return;
    const tier = snapshot.find((b) => b.adsApiAccessTier)?.adsApiAccessTier;
    logger.info(
      {
        event: "meta_rate_usage",
        buckets: snapshot.length,
        maxCallPct: snapshot.reduce((m, b) => Math.max(m, b.callCount), 0),
        adsApiAccessTier: tier,
      },
      "Meta API usage snapshot",
    );
    if (tier === "development_access") {
      logger.warn(
        { event: "meta_access_tier" },
        "Running on development_access tier — apply for Advanced Access to raise the Ads Management / Insights quota",
      );
    }
  }
}

/**
 * Extract the first id-like segment after the API version. For account-scoped
 * paths like `/act_123/insights` or `/act_123/campaigns`, returns `act_123`.
 * For `/<object_id>/insights` etc., returns `<object_id>`.
 */
function extractAccountId(path: string): string | undefined {
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  const [first] = stripped.split("/");
  if (!first) return undefined;
  if (/^act_\d+$/i.test(first)) return first;
  if (/^\d+$/.test(first)) return first;
  return undefined;
}

/**
 * Best-effort hint for which BUC pool a request counts against. Used to scope
 * circuit-breaker state — a throttle on Insights should not freeze Audience
 * writes for the same account.
 */
function guessBucType(method: string, path: string): string {
  if (/\/insights(\?|$|\/)/.test(path) || /\/insights$/.test(path)) {
    return "ads_insights";
  }
  if (/\/customaudiences(\?|$|\/)/.test(path) || path.includes("/customaudiences")) {
    return "custom_audience";
  }
  if (method === "POST" || method === "DELETE") {
    return "ads_management";
  }
  return "ads_management";
}

/**
 * Singleton client instance used by all tools.
 */
export const metaApiClient = new MetaApiClient();
