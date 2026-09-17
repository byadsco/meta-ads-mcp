import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatasetLookup, DatasetItemNotFoundError } from "../../src/apify/dataset-lookup.js";
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
    expect(urls[1].searchParams.get("fields")).toBe("ad_archive_id");
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
