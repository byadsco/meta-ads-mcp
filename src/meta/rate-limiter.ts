import { logger } from "../utils/logger.js";

/**
 * Rate limiter that reads Meta's X-App-Usage and X-Business-Use-Case-Usage headers.
 *
 * Throttles requests when usage approaches limits to avoid hitting 429s.
 */
export class RateLimiter {
  private appUsagePercent = 0;
  private accountUsagePercent = 0;
  /**
   * Update usage from Meta API response headers.
   */
  updateFromHeaders(headers: Headers): void {
    const appUsage = headers.get("x-app-usage");
    if (appUsage) {
      try {
        const usage = JSON.parse(appUsage) as {
          call_count?: number;
          total_cputime?: number;
          total_time?: number;
        };
        this.appUsagePercent = Math.max(
          usage.call_count ?? 0,
          usage.total_cputime ?? 0,
          usage.total_time ?? 0,
        );
      } catch {
        // Ignore parse errors
      }
    }

    const businessUsage = headers.get("x-business-use-case-usage");
    if (businessUsage) {
      try {
        const usage = JSON.parse(businessUsage) as Record<
          string,
          Array<{
            call_count?: number;
            total_cputime?: number;
            total_time?: number;
          }>
        >;
        let maxUsage = 0;
        for (const entries of Object.values(usage)) {
          for (const entry of entries) {
            maxUsage = Math.max(
              maxUsage,
              entry.call_count ?? 0,
              entry.total_cputime ?? 0,
              entry.total_time ?? 0,
            );
          }
        }
        this.accountUsagePercent = maxUsage;
      } catch {
        // Ignore parse errors
      }
    }

  }

  /**
   * Returns delay in ms if we should throttle, 0 if clear.
   */
  getThrottleDelay(): number {
    const usage = Math.max(this.appUsagePercent, this.accountUsagePercent);

    if (usage < 75) return 0;
    if (usage < 95) {
      // Linear backoff: 100ms at 75% to 2000ms at 95%
      const ratio = (usage - 75) / 20;
      return Math.round(100 + ratio * 1900);
    }
    // Exponential backoff above 95%
    const ratio = (usage - 95) / 5;
    return Math.round(5000 + ratio * 55000); // 5s to 60s
  }

  /**
   * Wait if throttled.
   */
  async waitIfNeeded(): Promise<void> {
    const delay = this.getThrottleDelay();
    if (delay > 0) {
      logger.warn(
        {
          delay,
          appUsage: this.appUsagePercent,
          accountUsage: this.accountUsagePercent,
        },
        "Rate limit throttling",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /**
   * Current usage percentage (for logging/monitoring).
   */
  get currentUsage(): number {
    return Math.max(this.appUsagePercent, this.accountUsagePercent);
  }
}
