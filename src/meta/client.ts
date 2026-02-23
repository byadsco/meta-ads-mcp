import { getAccessToken } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { RateLimiter } from "./rate-limiter.js";
import { isMetaApiError, mapMetaErrorToMcp } from "./errors.js";
import type { MetaApiResponse } from "./types/common.js";
import { collectAllPages } from "./paginator.js";

const DEFAULT_API_VERSION = "v22.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;

export interface MetaApiClientConfig {
  apiVersion?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
}

/**
 * Typed client for the Meta Graph API.
 *
 * Features:
 * - Automatic token resolution from AsyncLocalStorage / env
 * - Rate limiting based on X-App-Usage headers
 * - Retry with exponential backoff on 5xx / network errors
 * - Cursor-based pagination
 * - Meta error → MCP error mapping
 */
export class MetaApiClient {
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly rateLimiter = new RateLimiter();

  constructor(config?: MetaApiClientConfig) {
    this.apiVersion =
      config?.apiVersion ?? process.env.META_API_VERSION ?? DEFAULT_API_VERSION;
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
  }

  /**
   * GET request to a Graph API endpoint.
   */
  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.execute<T>("GET", url);
  }

  /**
   * POST request to a Graph API endpoint.
   */
  async post<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = this.buildUrl(path);
    return this.execute<T>("POST", url, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * POST with URL-encoded form body (used for some Meta endpoints).
   */
  async postForm<T>(
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = this.buildUrl(path);
    const formBody = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      formBody.set(key, String(value));
    }
    return this.execute<T>("POST", url, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });
  }

  /**
   * POST with multipart/form-data (used for image uploads).
   */
  async postMultipart<T>(
    path: string,
    formData: FormData,
  ): Promise<T> {
    const url = this.buildUrl(path);
    const token = getAccessToken();
    formData.set("access_token", token);
    // Don't set Content-Type — fetch will set it with boundary
    return this.execute<T>("POST", url, { body: formData }, true);
  }

  /**
   * DELETE request to a Graph API endpoint.
   */
  async delete<T>(path: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.execute<T>("DELETE", url);
  }

  /**
   * Fetch all pages of a paginated endpoint.
   */
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
    options?: RequestInit,
    skipTokenParam = false,
  ): Promise<T> {
    await this.rateLimiter.waitIfNeeded();

    const token = getAccessToken();

    // Add access_token as query param (standard for Meta API)
    const reqUrl = skipTokenParam
      ? url
      : this.appendToken(url, token);

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

        // Update rate limiter from response headers
        this.rateLimiter.updateFromHeaders(response.headers);

        const body = await response.json() as unknown;

        // Check for Meta API errors
        if (isMetaApiError(body)) {
          const mcpError = mapMetaErrorToMcp(body.error);

          // Don't retry auth errors or invalid params
          if (
            body.error.code === 190 ||
            body.error.code === 100 ||
            body.error.code === 10
          ) {
            throw mcpError;
          }

          // Retry rate limit errors
          if (
            body.error.code === 4 ||
            body.error.code === 17 ||
            body.error.code === 32
          ) {
            lastError = mcpError;
            await this.backoff(attempt);
            continue;
          }

          // Retry server errors
          if (body.error.code === 1 || body.error.code === 2) {
            lastError = mcpError;
            await this.backoff(attempt);
            continue;
          }

          throw mcpError;
        }

        if (!response.ok) {
          lastError = new Error(
            `HTTP ${response.status}: ${JSON.stringify(body)}`,
          );
          if (response.status >= 500) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        return body as T;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "AbortError"
        ) {
          lastError = new Error(`Request timeout after ${this.timeout}ms`);
          if (attempt < this.maxRetries) {
            await this.backoff(attempt);
            continue;
          }
        }

        // If it's already an MCP error, don't wrap it
        if (error instanceof Error && "code" in error) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
      }
    }

    logger.error({ error: lastError }, "All retries exhausted");
    throw lastError ?? new Error("Request failed after retries");
  }

  private appendToken(url: string, token: string): string {
    const u = new URL(url);
    u.searchParams.set("access_token", token);
    return u.toString();
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
    const jitter = Math.random() * delay * 0.1;
    logger.debug({ attempt, delay: delay + jitter }, "Retrying after backoff");
    await new Promise((resolve) =>
      setTimeout(resolve, delay + jitter),
    );
  }
}

/**
 * Singleton client instance used by all tools.
 */
export const metaApiClient = new MetaApiClient();
