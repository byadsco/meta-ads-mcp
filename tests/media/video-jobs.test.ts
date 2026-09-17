import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createVideoJobRunner,
  VideoJobBusyError,
  VideoJobRateLimitError,
  type VideoJobContext,
} from "../../src/media/video-jobs.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createVideoJobRunner", () => {
  it("creates a private temp dir for the job and removes it afterwards, even on failure", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1 });
    let seen: string | undefined;

    await runner.run({ tenantId: "t1" }, async (ctx) => {
      seen = ctx.dir;
      await fs.writeFile(path.join(ctx.dir, "scratch.bin"), "x");
      expect(path.basename(ctx.dir)).toMatch(/^meta-ads-video-/);
    });
    await expect(fs.stat(seen as string)).rejects.toThrow();

    let failed: string | undefined;
    await expect(
      runner.run({ tenantId: "t1" }, async (ctx) => {
        failed = ctx.dir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.stat(failed as string)).rejects.toThrow();
  });

  it("limits concurrent jobs per instance and queues the rest", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 4, queueWaitMs: 5_000 });
    const gate = deferred<void>();
    const order: string[] = [];

    const first = runner.run({ tenantId: "t1" }, async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = runner.run({ tenantId: "t1" }, async () => {
      order.push("second-start");
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("rejects with VideoJobBusyError when the queue is full", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5_000 });
    const gate = deferred<void>();
    const running = runner.run({ tenantId: "t1" }, async () => gate.promise);
    const queued = runner.run({ tenantId: "t1" }, async () => undefined);

    await expect(runner.run({ tenantId: "t1" }, async () => undefined)).rejects.toBeInstanceOf(VideoJobBusyError);

    gate.resolve();
    await Promise.all([running, queued]);
  });

  it("rejects with VideoJobBusyError after waiting queueWaitMs without a slot", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 2, queueWaitMs: 30 });
    const gate = deferred<void>();
    const running = runner.run({ tenantId: "t1" }, async () => gate.promise);

    await expect(runner.run({ tenantId: "t1" }, async () => undefined)).rejects.toBeInstanceOf(VideoJobBusyError);

    gate.resolve();
    await running;
  });

  it("enforces a per-tenant sliding-window rate limit", async () => {
    let now = 1_000_000;
    const runner = createVideoJobRunner({ maxConcurrent: 2, perTenantPerHour: 2, now: () => now });

    await runner.run({ tenantId: "a" }, async () => undefined);
    await runner.run({ tenantId: "a" }, async () => undefined);
    await expect(runner.run({ tenantId: "a" }, async () => undefined)).rejects.toBeInstanceOf(VideoJobRateLimitError);
    // Other tenants are unaffected.
    await runner.run({ tenantId: "b" }, async () => undefined);

    now += 61 * 60 * 1000;
    await runner.run({ tenantId: "a" }, async () => undefined);
  });

  it("exposes a deadline and remaining budget to the job", async () => {
    let now = 5_000;
    const runner = createVideoJobRunner({ maxConcurrent: 1, budgetMs: 1_000, now: () => now });

    await runner.run({ tenantId: "t1" }, async (ctx: VideoJobContext) => {
      expect(ctx.deadline).toBe(6_000);
      expect(ctx.remainingMs()).toBe(1_000);
      now += 400;
      expect(ctx.remainingMs()).toBe(600);
      expect(ctx.outOfTime()).toBe(false);
      now += 700;
      expect(ctx.outOfTime()).toBe(true);
    });
  });

  it("propagates the caller's abort signal and aborts on deadline", async () => {
    const controller = new AbortController();
    const runner = createVideoJobRunner({ maxConcurrent: 1, budgetMs: 60_000 });

    await runner.run({ tenantId: "t1", signal: controller.signal }, async (ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      controller.abort();
      expect(ctx.signal.aborted).toBe(true);
    });
  });

  it("drops a queued job from the queue as soon as its caller aborts", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 2, queueWaitMs: 5_000 });
    const gate = deferred<void>();
    const running = runner.run({ tenantId: "t1" }, async () => gate.promise);
    const controller = new AbortController();
    const queued = runner.run({ tenantId: "t1", signal: controller.signal }, async () => "should not run");

    await new Promise((r) => setTimeout(r, 5));
    expect(runner.stats().queued).toBe(1);
    controller.abort();
    await expect(queued).rejects.toThrow(/abort/i);
    expect(runner.stats().queued).toBe(0);

    gate.resolve();
    await running;
  });

  it("does not run a job whose signal is already aborted", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1 });
    const controller = new AbortController();
    controller.abort();
    const job = vi.fn(async () => undefined);
    await expect(runner.run({ tenantId: "t1", signal: controller.signal }, job)).rejects.toThrow(/abort/i);
    expect(job).not.toHaveBeenCalled();
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0 });
  });

  it("releases the slot only after the scratch directory is gone", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 1, queueWaitMs: 5_000 });
    let firstDir = "";
    let secondSawFirstDir: boolean | undefined;
    const first = runner.run({ tenantId: "t1" }, async (ctx) => {
      firstDir = ctx.dir;
      await fs.writeFile(path.join(ctx.dir, "big.bin"), Buffer.alloc(1024));
    });
    const second = runner.run({ tenantId: "t1" }, async () => {
      secondSawFirstDir = await fs.stat(firstDir).then(() => true, () => false);
    });
    await Promise.all([first, second]);
    expect(secondSawFirstDir).toBe(false);
  });

  it("forgets tenants whose rate window has fully expired", async () => {
    let now = 1_000_000;
    const runner = createVideoJobRunner({ maxConcurrent: 2, perTenantPerHour: 5, now: () => now });
    for (let i = 0; i < 50; i++) {
      await runner.run({ tenantId: `tenant-${i}` }, async () => undefined);
    }
    expect(runner.stats().tracked_tenants).toBe(50);
    now += 2 * 60 * 60 * 1000;
    await runner.run({ tenantId: "fresh" }, async () => undefined);
    expect(runner.stats().tracked_tenants).toBe(1);
  });

  it("reports the number of running and queued jobs", async () => {
    const runner = createVideoJobRunner({ maxConcurrent: 1, maxQueued: 2, queueWaitMs: 5_000 });
    const gate = deferred<void>();
    const a = runner.run({ tenantId: "t1" }, async () => gate.promise);
    const b = runner.run({ tenantId: "t1" }, async () => undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.stats()).toMatchObject({ running: 1, queued: 1 });
    gate.resolve();
    await Promise.all([a, b]);
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0 });
  });
});
