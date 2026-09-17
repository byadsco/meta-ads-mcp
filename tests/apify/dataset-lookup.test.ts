import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatasetLookup, DatasetItemNotFoundError } from "../../src/apify/dataset-lookup.js";
import { ApifyApiClient } from "../../src/apify/client.js";
import { mockFetchResponse } from "../setup.js";

const TOKEN = "apify_api_testfixture";

function calls(): URL[] {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((c) => new URL(String((c as [string])[0])));
}

const FULL = { ad_archive_id: "5550000000001", page_name: "Nike", snapshot: { body: { text: "Just do it" } } };

describe("findDatasetItem", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("fetches the single record at hint_offset when the id matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse([FULL])));
    const lookup = createDatasetLookup();

    const found = await lookup.findDatasetItem("ds123abcde", "5550000000001", { hintOffset: 42 });

    expect(found).toEqual({ item: FULL, offset: 42 });
    const [url] = calls();
    expect(url.pathname).toBe("/v2/datasets/ds123abcde/items");
    expect(url.searchParams.get("offset")).toBe("42");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("fields")).toBeNull();
  });

  it("falls back to an id-only scan when the hint does not match, then fetches the full record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "9990000000009" }]))
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "1110000000001" }, { ad_archive_id: "5550000000001" }, { ad_archive_id: "7770000000007" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL])),
    );
    const lookup = createDatasetLookup({ pageSize: 1000 });

    const found = await lookup.findDatasetItem("ds123abcde", "5550000000001", { hintOffset: 3 });

    expect(found).toEqual({ item: FULL, offset: 1 });
    const urls = calls();
    expect(urls).toHaveLength(3);
    expect(urls[1].searchParams.get("fields")).toBe("ad_archive_id,adArchiveID");
    expect(urls[1].searchParams.get("limit")).toBe("1000");
    expect(urls[1].searchParams.get("offset")).toBe("0");
    expect(urls[2].searchParams.get("offset")).toBe("1");
    expect(urls[2].searchParams.get("limit")).toBe("1");
  });

  it("pages the scan and stops at the configured maximum", async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ ad_archive_id: String(10000 + i) }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(page)));
    const lookup = createDatasetLookup({ pageSize: 2, maxItems: 6 });

    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toBeInstanceOf(DatasetItemNotFoundError);
    expect(calls().map((u) => u.searchParams.get("offset"))).toEqual(["0", "2", "4"]);
  });

  it("stops scanning at a short page (end of dataset)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "10001" }])));
    const lookup = createDatasetLookup({ pageSize: 1000 });

    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/not found/);
    expect(calls()).toHaveLength(1);
  });

  it("caches the id to offset map per dataset so a second lookup skips the scan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }, { ad_archive_id: "5560000000002" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL]))
        .mockResolvedValueOnce(mockFetchResponse([{ ...FULL, ad_archive_id: "5560000000002" }])),
    );
    const lookup = createDatasetLookup({ pageSize: 1000 });

    await lookup.findDatasetItem("ds123abcde", "5550000000001");
    const second = await lookup.findDatasetItem("ds123abcde", "5560000000002");

    expect(second.offset).toBe(1);
    expect(calls()).toHaveLength(3);
  });

  it("re-scans after the cache entry expires", async () => {
    let now = 1_000;
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL]))
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL])),
    );
    const lookup = createDatasetLookup({ pageSize: 1000, ttlMs: 100, now: () => now });

    await lookup.findDatasetItem("ds123abcde", "5550000000001");
    now += 200;
    await lookup.findDatasetItem("ds123abcde", "5550000000001");

    expect(calls()).toHaveLength(4);
  });

  it("scopes the cached offset map to the tenant that scanned the dataset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL]))
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL])),
    );
    let tenant = "tenant-a";
    const lookup = createDatasetLookup({ pageSize: 1000, tenantId: () => tenant });

    await lookup.findDatasetItem("ds123abcde", "5550000000001");
    tenant = "tenant-b";
    await lookup.findDatasetItem("ds123abcde", "5550000000001");

    // Tenant B never benefits from tenant A scan: it rescans with its own token.
    expect(calls()).toHaveLength(4);
  });

  it("remembers a fully scanned dataset so a missing id does not trigger another scan", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([{ ad_archive_id: "1110000000001" }])));
    const lookup = createDatasetLookup({ pageSize: 1000 });

    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/not found/);
    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/not found/);
    await expect(lookup.findDatasetItem("ds123abcde", "8888888888888")).rejects.toThrow(/not found/);
    expect(calls()).toHaveLength(1);
  });

  it("does not rescan a dataset that hit the scan cap until the cache expires", async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ ad_archive_id: String(10000 + i) }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(page)));
    const lookup = createDatasetLookup({ pageSize: 2, maxItems: 4 });

    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/larger than/);
    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/larger than/);
    expect(calls()).toHaveLength(2);
  });

  it("shares an in-flight scan between concurrent lookups of the same dataset", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      if (params.get("fields")?.startsWith("ad_archive_id")) {
        await gate;
        return mockFetchResponse([{ ad_archive_id: "5550000000001" }, { ad_archive_id: "5560000000002" }]);
      }
      return mockFetchResponse([{ ...FULL, ad_archive_id: params.get("offset") === "1" ? "5560000000002" : "5550000000001" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDatasetLookup({ pageSize: 1000 });

    const a = lookup.findDatasetItem("ds123abcde", "5550000000001");
    const b = lookup.findDatasetItem("ds123abcde", "5560000000002");
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([a, b]);

    // one scan + two single-record fetches
    expect(calls().filter((u) => u.searchParams.get("fields")?.startsWith("ad_archive_id"))).toHaveLength(1);
  });

  it("only caches well-formed ids and bounds the number of cached entries", async () => {
    const junk = Array.from({ length: 50 }, (_, i) => ({ ad_archive_id: "j".repeat(8000) + i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(junk)));
    const lookup = createDatasetLookup({ pageSize: 1000 });

    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/not found/);
    expect(lookup.stats().cached_ids).toBe(0);
  });

  it("keeps scanning after a shared scan stopped at another caller target", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const rows = ["1000000000000", "1000000000001", "1000000000002", "1000000000003"];
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      if (params.get("fields")) {
        if (offset === 0) await gate;
        const limit = Number(params.get("limit"));
        return mockFetchResponse(rows.slice(offset, offset + limit).map((id) => ({ ad_archive_id: id })));
      }
      return mockFetchResponse([{ ad_archive_id: rows[offset] }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDatasetLookup({ pageSize: 2, maxItems: 10 });

    const first = lookup.findDatasetItem("ds123abcde", "1000000000000");
    const second = lookup.findDatasetItem("ds123abcde", "1000000000003");
    await new Promise((r) => setTimeout(r, 5));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(3);
  });

  it("does not reuse a stale in-flight scan after the cache was invalidated by a mismatch", async () => {
    // Dataset rows: id A at 0, then B at 1. After the first scan, the dataset
    // changes so that offset 0 now holds C; a lookup for A must rescan and fail
    // cleanly instead of reusing the old map.
    const phase = { changed: false };
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      const rowsNow = phase.changed ? ["3000000000003", "2000000000002"] : ["1000000000001", "2000000000002"];
      if (params.get("fields")) {
        const limit = Number(params.get("limit"));
        return mockFetchResponse(rowsNow.slice(offset, offset + limit).map((id) => ({ ad_archive_id: id })));
      }
      return mockFetchResponse([{ ad_archive_id: rowsNow[offset] }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDatasetLookup({ pageSize: 1000 });

    await lookup.findDatasetItem("ds123abcde", "1000000000001");
    phase.changed = true;
    await expect(lookup.findDatasetItem("ds123abcde", "1000000000001")).rejects.toThrow(/not found/);
    const found = await lookup.findDatasetItem("ds123abcde", "3000000000003");
    expect(found.offset).toBe(0);
  });

  it("projects the legacy adArchiveID alias during the scan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ adArchiveID: "1000000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([{ adArchiveID: "1000000000001", pageName: "Legacy" }])),
    );
    const lookup = createDatasetLookup({ pageSize: 1000 });
    const found = await lookup.findDatasetItem("ds123abcde", "1000000000001");
    expect(found.offset).toBe(0);
    expect(calls()[0].searchParams.get("fields")).toBe("ad_archive_id,adArchiveID");
  });

  it("never keeps a single entry above the total id budget", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ ad_archive_id: String(1000000000000 + i) }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(rows)));
    const lookup = createDatasetLookup({ pageSize: 1000, maxTotalIds: 2 });
    await expect(lookup.findDatasetItem("ds123abcde", "9999999999999")).rejects.toThrow(/not found/);
    expect(lookup.stats().cached_ids).toBeLessThanOrEqual(2);
  });

  it("discards a joined scan whose generation was invalidated while it was suspended", async () => {
    const id = (n: number) => String(1000000000000 + n);
    let rows = [id(0), id(1), id(2), id(3)];
    let releaseOffset2!: () => void;
    const gate = new Promise<void>((r) => { releaseOffset2 = r; });
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      if (params.get("fields")) {
        if (offset === 2 && !gateReleased) await gate;
        const limit = Number(params.get("limit"));
        return mockFetchResponse(rows.slice(offset, offset + limit).map((v) => ({ ad_archive_id: v })));
      }
      return mockFetchResponse(rows[offset] ? [{ ad_archive_id: rows[offset] }] : []);
    });
    let gateReleased = false;
    vi.stubGlobal("fetch", fetchMock);
    const lookup = createDatasetLookup({ pageSize: 2, maxItems: 100 });

    await lookup.findDatasetItem("ds123abcde", id(0));
    const suspended = lookup.findDatasetItem("ds123abcde", id(2));
    await new Promise((r) => setTimeout(r, 5));
    const waiter = lookup.findDatasetItem("ds123abcde", id(4));
    await new Promise((r) => setTimeout(r, 5));

    rows = [id(4), id(0), id(2), id(3)];
    const moved = await lookup.findDatasetItem("ds123abcde", id(0));
    expect(moved.offset).toBe(1);

    gateReleased = true;
    releaseOffset2();
    const [two, four] = await Promise.all([suspended, waiter]);
    expect(two.offset).toBe(2);
    expect(four.offset).toBe(0);
    expect((await lookup.findDatasetItem("ds123abcde", id(4))).offset).toBe(0);
  });

  it("treats an empty 200 body as an error, never as a complete empty dataset", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), text: async () => "" })
      .mockResolvedValue(mockFetchResponse([{ ad_archive_id: "1000000000001" }])));
    // No retries here so the empty body surfaces as the error it is (the shared client would retry it).
    const lookup = createDatasetLookup({ pageSize: 1000, client: new ApifyApiClient({ maxRetries: 0 }) });
    await expect(lookup.findDatasetItem("ds123abcde", "1000000000001")).rejects.toThrow(/empty|unexpected/i);
    const found = await lookup.findDatasetItem("ds123abcde", "1000000000001");
    expect(found.offset).toBe(0);
  });

  it("rejects a non-array page instead of caching it as complete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ error: "nope" })));
    const lookup = createDatasetLookup({ pageSize: 1000, client: new ApifyApiClient({ maxRetries: 0 }) });
    await expect(lookup.findDatasetItem("ds123abcde", "1000000000001")).rejects.toThrow(/unexpected/i);
    expect(lookup.stats().cached_datasets).toBe(0);
  });

  it("serves many concurrent lookups over a page-size-1 scan without false negatives", async () => {
    const ids = Array.from({ length: 70 }, (_, i) => String(1000000000000 + i));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      return mockFetchResponse(ids.slice(offset, offset + limit).map((v) => ({ ad_archive_id: v })));
    }));
    const lookup = createDatasetLookup({ pageSize: 1, maxItems: 100 });
    const results = await Promise.all(ids.map((v) => lookup.findDatasetItem("ds123abcde", v)));
    expect(results.map((r) => r.offset)).toEqual(ids.map((_, i) => i));
  });

  it("forgets generation state once a dataset has no cache entry and no scan in flight", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([{ ad_archive_id: "1000000000001" }])));
    let now = 1_000;
    const lookup = createDatasetLookup({ pageSize: 1000, ttlMs: 100, now: () => now });
    await lookup.findDatasetItem("ds123abcde", "1000000000001");
    // A mismatch invalidates the entry (row 0 now holds another id).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([{ ad_archive_id: "2000000000002" }])));
    await expect(lookup.findDatasetItem("ds123abcde", "1000000000001")).rejects.toThrow(/not found/);
    now += 1_000;
    await expect(lookup.findDatasetItem("ds123abcde", "3000000000003")).rejects.toThrow(/not found/);
    now += 1_000;
    lookup.stats();
    expect(lookup.stats().generations).toBe(0);
  });

  it("does not report a false no-progress error when a caller joins a scan that already published its page", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => String(1000000000000 + i));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      return mockFetchResponse(ids.slice(offset, offset + limit).map((v) => ({ ad_archive_id: v })));
    }));
    const lookup = createDatasetLookup({ pageSize: 1000, maxItems: 5000 });

    const first = lookup.findDatasetItem("ds123abcde", ids[0]);
    // Two microtasks later the first page is published but the scan promise may still be registered.
    await Promise.resolve();
    await Promise.resolve();
    const last = lookup.findDatasetItem("ds123abcde", ids[1000]);
    const [a, b] = await Promise.all([first, last]);
    expect(a.offset).toBe(0);
    expect(b.offset).toBe(1000);
  });

  it("gives up with a clear error when the dataset keeps changing under every rescan", async () => {
    let version = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      const offset = Number(params.get("offset"));
      if (params.get("fields")) {
        // Every scan sees the target at offset 0...
        return mockFetchResponse(offset === 0 ? [{ ad_archive_id: "1000000000001" }] : []);
      }
      // ...but the full fetch always returns a different ad there.
      version += 1;
      return mockFetchResponse([{ ad_archive_id: String(2000000000000 + version) }]);
    }));
    const lookup = createDatasetLookup({ pageSize: 1000 });
    await expect(lookup.findDatasetItem("ds123abcde", "1000000000001")).rejects.toThrow(/changing|not found/);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(20);
  });

  it("never reuses a generation identity after the key state was forgotten", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([{ ad_archive_id: "1000000000001" }])));
    let now = 1_000;
    const lookup = createDatasetLookup({ pageSize: 1000, ttlMs: 100, now: () => now });
    await lookup.findDatasetItem("ds123abcde", "1000000000001");
    const before = lookup.stats().generation_ids;
    now += 1_000;
    lookup.stats();
    await lookup.findDatasetItem("ds123abcde", "1000000000001");
    const after = lookup.stats().generation_ids;
    expect(after).not.toEqual(before);
    expect(after.every((g) => g > 0)).toBe(true);
  });

  it("leaves no orphan generation behind after a lookup that failed on a second mismatch", async () => {
    let version = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      if (params.get("fields")) return mockFetchResponse([{ ad_archive_id: "1000000000001" }]);
      version += 1;
      return mockFetchResponse([{ ad_archive_id: String(2000000000000 + version) }]);
    }));
    const lookup = createDatasetLookup({ pageSize: 1000 });
    for (const ds of ["ds123abcde", "ds123abcdf", "ds123abcdg"]) {
      await expect(lookup.findDatasetItem(ds, "1000000000001")).rejects.toThrow();
    }
    expect(lookup.stats()).toMatchObject({ cached_datasets: 0, in_flight: 0, generations: 0 });
  });

  it("rejects malformed ids before any request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const lookup = createDatasetLookup();
    await expect(lookup.findDatasetItem("../etc", "5550000000001")).rejects.toThrow(/Invalid Apify dataset id/);
    await expect(lookup.findDatasetItem("ds123abcde", "abc")).rejects.toThrow(/ad_archive_id/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("treats a record whose id changed under the hint as a miss rather than returning the wrong ad", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse([{ ...FULL, ad_archive_id: "5560000000002" }]))
        .mockResolvedValueOnce(mockFetchResponse([{ ad_archive_id: "5550000000001" }]))
        .mockResolvedValueOnce(mockFetchResponse([FULL])),
    );
    const lookup = createDatasetLookup({ pageSize: 1000 });

    const found = await lookup.findDatasetItem("ds123abcde", "5550000000001", { hintOffset: 9 });
    expect(found.item.ad_archive_id).toBe("5550000000001");
    expect(found.offset).toBe(0);
  });
});
