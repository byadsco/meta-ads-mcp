import { describe, expect, it } from "vitest";
import { withDeadline } from "../../src/utils/with-deadline.js";

describe("withDeadline", () => {
  it("returns the value when the promise settles inside the deadline", async () => {
    const result = await withDeadline(Promise.resolve(42), 1_000);
    expect(result).toEqual({ settled: true, value: 42 });
  });

  it("gives up waiting at the deadline and lets the promise finish on its own", async () => {
    let finished = false;
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => {
        finished = true;
        resolve("late");
      }, 60);
    });

    const result = await withDeadline(slow, 10);
    expect(result).toEqual({ settled: false });
    expect(finished).toBe(false);

    await expect(slow).resolves.toBe("late");
    expect(finished).toBe(true);
  });

  it("treats a rejection as not settled rather than throwing", async () => {
    const result = await withDeadline(Promise.reject(new Error("boom")), 1_000);
    expect(result).toEqual({ settled: false });
  });
});
