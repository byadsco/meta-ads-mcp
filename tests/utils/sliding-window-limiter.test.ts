import { describe, expect, it } from "vitest";
import { createSlidingWindowLimiter } from "../../src/utils/sliding-window-limiter.js";

describe("createSlidingWindowLimiter", () => {
  it("allows up to the limit per key inside the window and recovers afterwards", () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.acquire("a")).not.toBeNull();
    expect(limiter.acquire("a")).not.toBeNull();
    expect(limiter.acquire("a")).toBeNull();
    expect(limiter.acquire("b")).not.toBeNull();

    now = 1000;
    expect(limiter.acquire("a")).not.toBeNull();
  });

  it("gives a slot back on refund, once", () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    const permit = limiter.acquire("a");
    expect(limiter.acquire("a")).toBeNull();
    permit?.refund();
    permit?.refund();
    const second = limiter.acquire("a");
    expect(second).not.toBeNull();
    expect(limiter.acquire("a")).toBeNull();
  });

  it("forgets keys whose window expired so the map cannot grow without bound", () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 1000, now: () => now });
    for (let i = 0; i < 500; i++) limiter.acquire("tenant-" + i);
    expect(limiter.stats().tracked_keys).toBe(500);
    now = 5000;
    limiter.acquire("fresh");
    expect(limiter.stats().tracked_keys).toBe(1);
  });
});
