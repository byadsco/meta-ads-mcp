import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter } from "../../src/meta/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe("getThrottleDelay", () => {
    it("returns 0 when no headers have been processed", () => {
      expect(limiter.getThrottleDelay()).toBe(0);
    });

    it("returns 0 when usage is below 75%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 50,
            total_cputime: 30,
            total_time: 40,
          }),
        }),
      );
      expect(limiter.getThrottleDelay()).toBe(0);
    });

    it("returns linear backoff between 75-95%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 85,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
      );
      const delay = limiter.getThrottleDelay();
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThan(2100);
    });

    it("returns higher delay above 95%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 98,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
      );
      const delay = limiter.getThrottleDelay();
      expect(delay).toBeGreaterThanOrEqual(5000);
    });
  });

  describe("updateFromHeaders", () => {
    it("reads x-app-usage header", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 80,
            total_cputime: 10,
            total_time: 20,
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(80);
    });

    it("takes max of all app usage values", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 10,
            total_cputime: 90,
            total_time: 50,
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(90);
    });

    it("reads x-business-use-case-usage header", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-business-use-case-usage": JSON.stringify({
            "12345": [
              { call_count: 85, total_cputime: 20, total_time: 30 },
            ],
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(85);
    });

    it("handles max across multiple business accounts", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-business-use-case-usage": JSON.stringify({
            "11111": [
              { call_count: 40, total_cputime: 10, total_time: 10 },
            ],
            "22222": [
              { call_count: 92, total_cputime: 10, total_time: 10 },
            ],
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(92);
    });

    it("ignores malformed x-app-usage header", () => {
      limiter.updateFromHeaders(
        new Headers({ "x-app-usage": "not json" }),
      );
      expect(limiter.currentUsage).toBe(0);
    });

    it("handles missing headers gracefully", () => {
      limiter.updateFromHeaders(new Headers());
      expect(limiter.currentUsage).toBe(0);
    });

    it("takes max of app and business usage", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 50,
            total_cputime: 0,
            total_time: 0,
          }),
          "x-business-use-case-usage": JSON.stringify({
            "123": [{ call_count: 80, total_cputime: 0, total_time: 0 }],
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(80);
    });
  });

  describe("waitIfNeeded", () => {
    it("does not wait when usage is low", async () => {
      const start = Date.now();
      await limiter.waitIfNeeded();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("waits when usage is high", async () => {
      vi.useFakeTimers();
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 85,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
      );

      const promise = limiter.waitIfNeeded();
      vi.advanceTimersByTime(2100);
      await promise;
      vi.useRealTimers();
    });
  });

  describe("currentUsage", () => {
    it("returns 0 initially", () => {
      expect(limiter.currentUsage).toBe(0);
    });

    it("updates after processing headers", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 45,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
      );
      expect(limiter.currentUsage).toBe(45);
    });
  });
});
