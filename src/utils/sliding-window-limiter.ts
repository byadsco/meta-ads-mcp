export interface LimiterPermit {
  /** Gives the slot back, for work that ended before it cost anything. Idempotent. */
  refund(): void;
}

export interface SlidingWindowLimiter {
  /** Null when the key already used its allowance inside the window. */
  acquire(key: string): LimiterPermit | null;
  readonly limit: number;
  stats(): { tracked_keys: number };
}

export interface SlidingWindowLimiterConfig {
  limit: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Per-key sliding window kept in memory, so the ceiling is per instance.
 * Expired keys are dropped on every call, which bounds the map by the number
 * of keys active inside one window.
 */
export function createSlidingWindowLimiter(config: SlidingWindowLimiterConfig): SlidingWindowLimiter {
  const now = config.now ?? Date.now;
  const windows = new Map<string, number[]>();

  const purge = (current: number): void => {
    for (const [key, stamps] of windows) {
      const recent = stamps.filter((t) => current - t < config.windowMs);
      if (recent.length === 0) windows.delete(key);
      else if (recent.length !== stamps.length) windows.set(key, recent);
    }
  };

  return {
    limit: config.limit,
    acquire(key) {
      const current = now();
      purge(current);
      const stamps = windows.get(key) ?? [];
      if (stamps.length >= config.limit) return null;
      stamps.push(current);
      windows.set(key, stamps);
      let refunded = false;
      return {
        refund() {
          if (refunded) return;
          refunded = true;
          const live = windows.get(key);
          if (!live) return;
          const index = live.indexOf(current);
          if (index >= 0) live.splice(index, 1);
          if (live.length === 0) windows.delete(key);
        },
      };
    },
    stats() {
      return { tracked_keys: windows.size };
    },
  };
}
