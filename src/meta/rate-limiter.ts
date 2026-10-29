import { logger } from "../utils/logger.js";

/**
 * Context threaded with every Graph API request so rate-limit usage is tracked
 * per (token, account, use-case type) bucket instead of as a single global.
 * An agency with many ad accounts must not let one hot account slow down the
 * others.
 */
export interface RequestContext {
  tokenHash: string;
  accountId?: string;
}

/**
 * One bucket per resource Meta tracks independently. Keys are opaque strings
 * composed by `bucketKey(...)`.
 */
export interface UsageBucket {
  kind: "app" | "buc" | "insights" | "acc" | "reach" | "local_retry";
  key: string;
  callCount: number;
  cpuTime: number;
  totalTime: number;
  estimatedTimeToRegainAccessMs: number;
  adsApiAccessTier?: "development_access" | "standard_access" | string;
  updatedAt: number;
}

// What the headers carry is logged and shown by ads_rate_status, so only
// numbers, id-shaped keys and Meta's own tier values are kept.
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const knownTier = (tier: unknown): "development_access" | "standard_access" | undefined =>
  tier === "development_access" || tier === "standard_access" ? tier : undefined;

interface BucUsageEntry {
  type?: string;
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number; // in minutes
  ads_api_access_tier?: string;
}

interface InsightsThrottleHeader {
  app_id_util_pct?: number;
  acc_id_util_pct?: number;
  ads_api_access_tier?: string;
}

interface AdAccountUsageHeader {
  acc_id_util_pct?: number;
  reset_time_duration?: number;
  ads_api_access_tier?: string;
}

interface ReachThrottleHeader {
  call_count?: number;
  reset_time_duration?: number;
}

/**
 * Rate limiter that reads Meta's usage headers per request and decides when to
 * self-throttle before the next call. Parses:
 *
 *  - X-App-Usage (platform limits, per token)
 *  - X-Business-Use-Case-Usage (BUC limits, per business_id × type)
 *  - x-fb-ads-insights-throttle (Insights-specific app/account load)
 *  - x-ad-account-usage (ad-account-level quota)
 *  - x-Fb-Ads-Insights-Reach-Throttle (10/day cap for reach+breakdowns >13mo)
 *
 * Strategy per bucket:
 *  - When the header carries `estimated_time_to_regain_access` (minutes),
 *    that's authoritative: self-wait for that long.
 *  - Otherwise fall back to a usage-based staircase (linear 75–95 %,
 *    exponential above 95 %) so we self-slow before Meta throttles us.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, UsageBucket>();

  updateFromHeaders(headers: Headers, context: RequestContext): void {
    const now = Date.now();

    // ── X-App-Usage ──────────────────────────────────────
    const appUsage = headers.get("x-app-usage");
    if (appUsage) {
      const parsed = safeParse<BucUsageEntry>(appUsage);
      if (parsed) {
        this.writeBucket({
          kind: "app",
          key: bucketKey("app", context.tokenHash),
          callCount: num(parsed.call_count),
          cpuTime: num(parsed.total_cputime),
          totalTime: num(parsed.total_time),
          estimatedTimeToRegainAccessMs: 0,
          updatedAt: now,
        });
      }
    }

    // ── X-Business-Use-Case-Usage ────────────────────────
    const buc = headers.get("x-business-use-case-usage");
    if (buc) {
      const parsed = safeParse<Record<string, BucUsageEntry[]>>(buc);
      if (parsed) {
        for (const [businessId, entries] of Object.entries(parsed)) {
          if (!/^(act_)?\d{1,30}$/.test(businessId) || !Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (!entry || typeof entry !== "object") continue;
            const type = typeof entry.type === "string" && /^[a-z_]{1,40}$/.test(entry.type) ? entry.type : "unknown";
            this.writeBucket({
              kind: "buc",
              key: bucketKey("buc", context.tokenHash, businessId, type),
              callCount: num(entry.call_count),
              cpuTime: num(entry.total_cputime),
              totalTime: num(entry.total_time),
              estimatedTimeToRegainAccessMs:
                num(entry.estimated_time_to_regain_access) * 60 * 1000,
              adsApiAccessTier: knownTier(entry.ads_api_access_tier),
              updatedAt: now,
            });
          }
        }
      }
    }

    // ── x-fb-ads-insights-throttle ───────────────────────
    const insightsThrottle = headers.get("x-fb-ads-insights-throttle");
    if (insightsThrottle) {
      const parsed = safeParse<InsightsThrottleHeader>(insightsThrottle);
      if (parsed) {
        // App-scoped portion
        this.writeBucket({
          kind: "insights",
          key: bucketKey("insights", context.tokenHash, "app"),
          callCount: num(parsed.app_id_util_pct),
          cpuTime: 0,
          totalTime: 0,
          estimatedTimeToRegainAccessMs: 0,
          adsApiAccessTier: knownTier(parsed.ads_api_access_tier),
          updatedAt: now,
        });
        // Account-scoped portion
        if (context.accountId) {
          this.writeBucket({
            kind: "insights",
            key: bucketKey(
              "insights",
              context.tokenHash,
              "acc",
              context.accountId,
            ),
            callCount: num(parsed.acc_id_util_pct),
            cpuTime: 0,
            totalTime: 0,
            estimatedTimeToRegainAccessMs: 0,
            adsApiAccessTier: knownTier(parsed.ads_api_access_tier),
            updatedAt: now,
          });
        }
      }
    }

    // ── x-ad-account-usage ───────────────────────────────
    const accUsage = headers.get("x-ad-account-usage");
    if (accUsage && context.accountId) {
      const parsed = safeParse<AdAccountUsageHeader>(accUsage);
      if (parsed) {
        this.writeBucket({
          kind: "acc",
          key: bucketKey("acc", context.tokenHash, context.accountId),
          callCount: num(parsed.acc_id_util_pct),
          cpuTime: 0,
          totalTime: 0,
          estimatedTimeToRegainAccessMs:
            num(parsed.reset_time_duration) * 1000,
          adsApiAccessTier: knownTier(parsed.ads_api_access_tier),
          updatedAt: now,
        });
      }
    }

    // ── x-Fb-Ads-Insights-Reach-Throttle ─────────────────
    const reach = headers.get("x-fb-ads-insights-reach-throttle");
    if (reach && context.accountId) {
      const parsed = safeParse<ReachThrottleHeader>(reach);
      if (parsed) {
        this.writeBucket({
          kind: "reach",
          key: bucketKey("reach", context.tokenHash, context.accountId),
          callCount: num(parsed.call_count),
          cpuTime: 0,
          totalTime: 0,
          estimatedTimeToRegainAccessMs: num(parsed.reset_time_duration) * 1000,
          updatedAt: now,
        });
      }
    }
  }

  /**
   * Record a retry-after hint derived from an error body (headers sometimes
   * lag). Always account-scoped: we never want a per-account throttle signal
   * to block sibling accounts under the same token. The circuit breaker is
   * responsible for broader stops (e.g. abuse signal).
   */
  markRetryAfter(
    context: RequestContext,
    type: string,
    retryAfterMs: number,
  ): void {
    const scope = context.accountId ?? "_";
    const key = bucketKey("local_retry", context.tokenHash, scope, type);
    const now = Date.now();
    this.buckets.set(key, {
      kind: "local_retry",
      key,
      callCount: 0,
      cpuTime: 0,
      totalTime: 0,
      estimatedTimeToRegainAccessMs: retryAfterMs,
      updatedAt: now,
    });
  }

  /**
   * Compute how long we should wait before making a request in the given
   * context. Returns the max delay across all buckets that match.
   */
  getThrottleDelay(context: RequestContext): number {
    const now = Date.now();
    let maxDelay = 0;

    for (const bucket of this.buckets.values()) {
      if (!this.bucketAppliesTo(bucket, context)) continue;

      const explicitWait = Math.max(
        0,
        bucket.estimatedTimeToRegainAccessMs - (now - bucket.updatedAt),
      );
      if (explicitWait > 0) {
        maxDelay = Math.max(maxDelay, explicitWait);
        continue;
      }

      const usage = Math.max(bucket.callCount, bucket.cpuTime, bucket.totalTime);
      maxDelay = Math.max(maxDelay, staircaseDelay(usage));
    }

    return maxDelay;
  }

  async waitIfNeeded(context: RequestContext): Promise<void> {
    const delay = this.getThrottleDelay(context);
    if (delay > 0) {
      logger.warn(
        {
          event: "meta_rate_throttle",
          tokenHash: context.tokenHash,
          accountId: context.accountId,
          delayMs: delay,
        },
        "Self-throttling before Meta request",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Snapshot for observability / the `ads_rate_status` tool.
   */
  snapshot(): UsageBucket[] {
    return Array.from(this.buckets.values()).map((b) => ({ ...b }));
  }

  /** Clear state — used by tests. */
  reset(): void {
    this.buckets.clear();
  }

  private writeBucket(bucket: UsageBucket): void {
    this.buckets.set(bucket.key, bucket);
  }

  private bucketAppliesTo(
    bucket: UsageBucket,
    context: RequestContext,
  ): boolean {
    // Every bucket is scoped to a tokenHash as its first segment after kind.
    if (!bucket.key.includes(context.tokenHash)) return false;

    // Account-scoped buckets only apply when the request targets that account.
    if (bucket.kind === "acc" || bucket.kind === "reach") {
      return !!context.accountId && bucket.key.endsWith(`:${context.accountId}`);
    }
    if (bucket.kind === "insights") {
      // Insights buckets come in `:app` flavor (applies to all requests for
      // this token) and `:acc:<id>` flavor (only when account matches).
      if (bucket.key.endsWith(":app")) return true;
      return !!context.accountId && bucket.key.endsWith(`:${context.accountId}`);
    }
    if (bucket.kind === "local_retry") {
      // Always scoped to a specific (token, account, type) so one account's
      // retry-after never blocks sibling accounts.
      const scope = context.accountId ?? "_";
      return bucket.key.startsWith(
        bucketKey("local_retry", context.tokenHash, scope) + ":",
      );
    }
    // `app` and `buc` are token-scoped and apply broadly; specific BUC type
    // filtering happens at error-handling time, not at pre-flight throttle.
    return true;
  }
}

function staircaseDelay(usagePct: number): number {
  if (usagePct < 75) return 0;
  if (usagePct < 95) {
    // 100ms @ 75% → 2000ms @ 95%
    const ratio = (usagePct - 75) / 20;
    return Math.round(100 + ratio * 1900);
  }
  // 5s @ 95% → 60s @ 100%
  const ratio = Math.min(1, (usagePct - 95) / 5);
  return Math.round(5000 + ratio * 55000);
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function bucketKey(...parts: string[]): string {
  return parts.join(":");
}
