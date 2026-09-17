import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdLibraryVideoSources } from "../../src/media/ad-library-sources.js";
import { configureDatasetLookupForTests, createDatasetLookup } from "../../src/apify/dataset-lookup.js";
import type { AdLibraryRawItem } from "../../src/apify/ad-library-schema.js";
import { mockFetchResponse } from "../setup.js";

const ITEMS = JSON.parse(readFileSync(new URL("../fixtures/ad-library/items.json", import.meta.url), "utf8")) as AdLibraryRawItem[];
const VIDEO = ITEMS[1];
const ERROR_ITEM = ITEMS[6];
const DCO = ITEMS[3];

describe("resolveAdLibraryVideoSources", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "apify_api_testfixture";
    configureDatasetLookupForTests(createDatasetLookup());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
    configureDatasetLookupForTests(undefined);
  });

  it("resolves the videos of a scraped ad through the dataset lookup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse([VIDEO])));

    const sources = await resolveAdLibraryVideoSources({ dataset_id: "ds123abcde", ad_archive_id: "1178344137830897", hint_offset: 1 });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      origin: "ad_library",
      key: "library:1178344137830897:video:0",
      ad_archive_id: "1178344137830897",
      card_index: 0,
    });
    expect(sources[0].low_res_url).toMatch(/fbcdn/);
    expect(sources[0].thumbnail_url).toMatch(/fbcdn/);
  });

  it("returns every video card of a DCO ad", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse([DCO])));
    const sources = await resolveAdLibraryVideoSources({ dataset_id: "ds123abcde", ad_archive_id: "706579198992184", hint_offset: 3 });
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources.map((s) => s.key)).size).toBe(sources.length);
  });

  it("video_index addresses a video beyond the presentation caps", async () => {
    const raw = {
      ad_archive_id: "1178344137830897",
      page_name: "P",
      snapshot: { videos: Array.from({ length: 25 }, (_, i) => ({ video_sd_url: "https://video.xx.fbcdn.net/" + i + ".mp4" })) },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse([raw])));
    const sources = await resolveAdLibraryVideoSources({ dataset_id: "ds123abcde", ad_archive_id: "1178344137830897", hint_offset: 0, video_index: 22 });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ card_index: 22, low_res_url: "https://video.xx.fbcdn.net/22.mp4" });
  });

  it("rejects an actor error record instead of returning empty sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([ERROR_ITEM])));
    await expect(
      resolveAdLibraryVideoSources({ dataset_id: "ds123abcde", ad_archive_id: "1178344137830897", hint_offset: 6 }),
    ).rejects.toThrow(/not found|error record/);
  });
});
