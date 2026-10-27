import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Firestore } from "@google-cloud/firestore";
import {
  advancePostEditGeneration,
  claimPostEditLease,
  postEditGeneration,
  releasePostEditLease,
  resetPostEditLeasesForTests,
} from "../../src/store/post-edit-lease.js";

// The parts of Firestore the leases use, kept in a map: a read always sees
// the last write, as Firestore's own reads do.
function fakeFirestore(): Firestore {
  const docs = new Map<string, Record<string, unknown>>();
  const snap = (key: string) => ({ exists: docs.has(key), data: () => docs.get(key) });
  const ref = (key: string) => ({ key, get: async () => snap(key) });
  type Ref = ReturnType<typeof ref>;
  return {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      get: async (r: Ref) => snap(r.key),
      set: (r: Ref, data: Record<string, unknown>) => { docs.set(r.key, { ...data }); },
      update: (r: Ref, data: Record<string, unknown>) => { docs.set(r.key, { ...docs.get(r.key), ...data }); },
      delete: (r: Ref) => { docs.delete(r.key); },
    }),
  } as unknown as Firestore;
}

describe.each([
  ["in memory", () => resetPostEditLeasesForTests()],
  ["in Firestore", () => resetPostEditLeasesForTests(fakeFirestore())],
])("post edit leases (%s)", (_name, reset) => {
  beforeEach(() => {
    reset();
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

  it("counts the edits started on a post, each one only by the holder of its lease", async () => {
    expect(await postEditGeneration("6001_888")).toBe(0);
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    await claimPostEditLease("6001_888", "a");
    expect(await advancePostEditGeneration("6001_888", "b")).toBe(false);
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(true);
    expect(await postEditGeneration("6001_888")).toBe(1);
    expect(await postEditGeneration("6001_999")).toBe(0);
  });

  it("keeps the count of a post across its leases", async () => {
    await claimPostEditLease("6001_888", "a");
    await advancePostEditGeneration("6001_888", "a");
    await releasePostEditLease("6001_888", "a");
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    await claimPostEditLease("6001_888", "b");
    await advancePostEditGeneration("6001_888", "b");
    expect(await postEditGeneration("6001_888")).toBe(2);
  });

  it("does not count an edit for a holder whose lease ran out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    vi.setSystemTime(new Date("2026-10-26T12:10:01Z"));
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    expect(await postEditGeneration("6001_888")).toBe(0);
  });
});
