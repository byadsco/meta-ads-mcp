import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  claimPostEditLease,
  releasePostEditLease,
  resetPostEditLeasesForTests,
} from "../../src/store/post-edit-lease.js";

describe("post edit leases (in memory)", () => {
  beforeEach(() => {
    resetPostEditLeasesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one edit of a post run at a time", async () => {
    expect(await claimPostEditLease("6001_888", "a")).toBe(true);
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    expect(await claimPostEditLease("6001_999", "b")).toBe(true);
  });

  it("frees the post when its holder releases it, and only then", async () => {
    await claimPostEditLease("6001_888", "a");
    await releasePostEditLease("6001_888", "b");
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    await releasePostEditLease("6001_888", "a");
    expect(await claimPostEditLease("6001_888", "b")).toBe(true);
  });

  it("frees a post whose holder never released it after ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    vi.setSystemTime(new Date("2026-10-26T12:09:00Z"));
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    vi.setSystemTime(new Date("2026-10-26T12:10:01Z"));
    expect(await claimPostEditLease("6001_888", "b")).toBe(true);
  });
});
