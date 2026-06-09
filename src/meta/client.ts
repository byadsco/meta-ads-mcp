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
import type { MetaApiResponse } from "./types/common.js";
import { collectAllPages } from "./paginator.js";

const DEFAULT_API_VERSION = "v25.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const USAGE_LOG_INTERVAL_MS = 60_000;

export interface MetaApiClientConfig {
  apiVersion?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

interface RequestScope {
  accountId?: string;
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
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly rateLimiter = new RateLimiter();
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly writePacer = new WritePacer();
  private lastUsageLogAt = 0;

  constructor(config?: MetaApiClientConfig) {
    this.apiVersion =
      config?.apiVersion ?? process.env.META_API_VERSION ?? DEFAULT_API_VERSION;
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.execute<T>("GET", url, path);
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

  async delete<T>(path: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.execute<T>("DELETE", url, path);
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
   * Public snapshot for the `ads_rate_status` tool.
   */
  getUsageSnapshot() {
    return {
      usage: this.rateLimiter.snapshot(),
      circuits: this.circuitBreaker.snapshot(),
      writePacer: this.writePacer.snapshot(),
    };
  }

  resetForTests(): void {
    this.rateLimiter.reset();
    this.circuitBreaker.reset();
    this.writePacer.reset();
    this.lastUsageLogAt = 0;
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

    // Preventive write pacing for POST / DELETE on account-scoped paths.
    const isWrite =
      (method === "POST" || method === "DELETE") &&
      accountId !== undefined;
    if (isWrite) {
      await this.writePacer.acquire(tokenHash, accountId);
    }

    // Reactive self-throttle based on last-known usage headers.
    await this.rateLimiter.waitIfNeeded(context);

    const reqUrl = skipTokenParam ? url : this.appendToken(url, token);

    // POST to /act_<id>/<collection> creates new resources without native
    // idempotency on Meta's side — retrying a timeout/5xx/network error can
    // mint duplicates (e.g. two ad sets for one user intent). The /<id>/copies
    // edge (ad/ad set/campaign duplication) creates a resource on a non-act_
    // path, so it must be classed as creating too — otherwise a retried copy
    // mints a duplicate ad. Other POSTs (updates on /<id>) and DELETEs are
    // idempotent at the API level.
    const isCreatingRequest =
      method === "POST" &&
      (/^\/?act_[A-Za-z0-9]+\//.test(path) || /\/copies$/.test(path));
    const canRetryTransport = !isCreatingRequest;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.timeout,
        );

        const response = await fetch(reqUrl, {
          method,
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Update rate-limiter + pacer from response headers — regardless of
        // whether the response was OK. Throttle signals travel on error
        // responses too.
        this.rateLimiter.updateFromHeaders(response.headers, context);
        this.maybeUpdatePacerTierFromHeaders(response.headers, tokenHash, accountId);
        this.maybeLogUsage();

        const body = (await response.json()) as unknown;

        if (isMetaApiError(body)) {
          const classification = classifyMetaError(body.error);
          this.logMetaError(body.error, classification, context, path);

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

          if (classification.retryable && canRetryTransport && attempt < this.maxRetries) {
            lastError = classification.mcpError;
            await this.backoff(attempt);
            continue;
          }

          throw classification.mcpError;
        }

        if (!response.ok) {
          lastError = new Error(
            `HTTP ${response.status}: ${JSON.stringify(body)}`,
          );
          if (response.status >= 500 && canRetryTransport && attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        return body as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${this.timeout}ms`);
          if (canRetryTransport && attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Already-classified errors bubble up unchanged.
        if (error instanceof Error && "code" in error) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (canRetryTransport && attempt < this.maxRetries) {
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
