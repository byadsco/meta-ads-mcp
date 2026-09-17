import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractLibraryVideoSources,
  isAdLibraryErrorItem,
  isTemplateCopy,
  libraryImageAssets,
  mediaSummary,
  normalizeLibraryAd,
  type AdLibraryRawItem,
} from "../../src/apify/ad-library-schema.js";

const ITEMS = JSON.parse(readFileSync(new URL("../fixtures/ad-library/items.json", import.meta.url), "utf8")) as AdLibraryRawItem[];
const [IMAGE, VIDEO, CAROUSEL, DCO, DPA, VIDEO_NO_HD, ERROR_ITEM, MIXED_CAROUSEL] = ITEMS;

describe("isAdLibraryErrorItem", () => {
  it("flags the actor error records and anything without an ad_archive_id", () => {
    expect(isAdLibraryErrorItem(ERROR_ITEM)).toBe(true);
    expect(isAdLibraryErrorItem({})).toBe(true);
    expect(isAdLibraryErrorItem(IMAGE)).toBe(false);
  });
});

describe("isTemplateCopy", () => {
  it("detects DCO / DPA placeholders", () => {
    expect(isTemplateCopy("{{product.name}}")).toBe(true);
    expect(isTemplateCopy("Buy {{ product.brand }} now")).toBe(true);
    expect(isTemplateCopy("Just do it")).toBe(false);
    expect(isTemplateCopy(null)).toBe(false);
  });
});

describe("normalizeLibraryAd", () => {
  it("normalizes an IMAGE ad: page, dates, platforms, copy and one image", () => {
    const ad = normalizeLibraryAd(IMAGE, 0);
    expect(ad.ad_archive_id).toBe("841513952022622");
    expect(ad.offset).toBe(0);
    expect(ad.ad_library_url).toBe("https://www.facebook.com/ads/library/?id=841513952022622");
    expect(ad.page).toMatchObject({ id: "183958198135625", name: "TB SHOP ", like_count: 40854, categories: ["Shopping Mall"] });
    expect(ad.page.profile_uri).toMatch(/^https:\/\/www\.facebook\.com\//);
    expect(ad.is_active).toBe(true);
    expect(ad.start_date).toBe("2026-01-02");
    expect(ad.publisher_platforms).toEqual(["FACEBOOK", "INSTAGRAM", "AUDIENCE_NETWORK", "MESSENGER", "THREADS"]);
    expect(ad.display_format).toBe("IMAGE");
    expect(typeof ad.copy.body).toBe("string");
    expect(ad.copy.cta_type).toBe("SHOP_NOW");
    expect(ad.copy.is_template).toBe(false);
    expect(ad.images).toHaveLength(1);
    expect(ad.images[0].original_url).toMatch(/fbcdn\.net/);
    expect(ad.images[0].resized_url).toMatch(/stp=dst-jpg_s600x600/);
    expect(ad.videos).toEqual([]);
    expect(ad.cards).toEqual([]);
    expect(ad.media_summary).toMatchObject({ image_count: 1, video_count: 0, has_video: false });
    expect(ad.media_summary.expires_at).toMatch(/^2026-01-/);
  });

  it("normalizes a VIDEO ad with hd, sd and preview urls", () => {
    const ad = normalizeLibraryAd(VIDEO, 7);
    expect(ad.display_format).toBe("VIDEO");
    expect(ad.videos).toHaveLength(1);
    expect(ad.videos[0]).toMatchObject({
      hd_url: expect.stringMatching(/^https:\/\/video\..*fbcdn\.net/),
      sd_url: expect.stringMatching(/^https:\/\/video\..*fbcdn\.net/),
      preview_image_url: expect.stringMatching(/fbcdn\.net/),
    });
    expect(ad.media_summary).toMatchObject({ image_count: 0, video_count: 1, has_video: true });
    expect(ad.impressions_text).toBeNull();
  });

  it("keeps a VIDEO ad usable when the HD rendition and the copy are null", () => {
    const ad = normalizeLibraryAd(VIDEO_NO_HD, 1);
    expect(ad.videos[0].hd_url).toBeNull();
    expect(ad.videos[0].sd_url).toMatch(/fbcdn/);
    expect(ad.copy.body).toBeNull();
    expect(ad.copy.title).toBeNull();
    expect(ad.media_summary.has_video).toBe(true);
  });

  it("normalizes a CAROUSEL into cards with their own copy and media", () => {
    const ad = normalizeLibraryAd(CAROUSEL, 2);
    expect(ad.display_format).toBe("CAROUSEL");
    expect(ad.cards.length).toBeGreaterThanOrEqual(3);
    expect(ad.cards[0]).toMatchObject({ index: 0 });
    expect(ad.cards[0].image?.original_url).toMatch(/fbcdn/);
    expect(ad.cards[0].video).toBeNull();
    expect(ad.media_summary.image_count).toBe(ad.cards.length);
  });

  it("marks DCO template copy and surfaces the real creative from the cards", () => {
    const ad = normalizeLibraryAd(DCO, 3);
    expect(ad.display_format).toBe("DCO");
    expect(ad.copy.is_template).toBe(true);
    expect(ad.copy.title).toBe("{{product.name}}");
    expect(ad.cards.some((c) => c.video !== null)).toBe(true);
    expect(ad.cards[0].body).not.toMatch(/\{\{/);
    expect(ad.media_summary.video_count).toBeGreaterThan(0);
  });

  it("normalizes a DPA ad with image cards", () => {
    const ad = normalizeLibraryAd(DPA, 4);
    expect(ad.display_format).toBe("DPA");
    expect(ad.cards.every((c) => c.image !== null)).toBe(true);
  });

  it("carries optional detail blocks and unknown top-level fields defensively", () => {
    const withDetails = { ...IMAGE, advertiser: { page: { id: "1" } }, aaa_info: { eu_total_reach: 1234 } } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(withDetails, 0);
    expect(ad.details?.aaa_info).toEqual({ eu_total_reach: 1234 });
    expect(normalizeLibraryAd({ ad_archive_id: "1" } as AdLibraryRawItem, 0)).toMatchObject({
      ad_archive_id: "1",
      page: { id: null, name: null },
      cards: [],
      copy: { body: null },
      media_summary: { image_count: 0, video_count: 0, has_video: false },
    });
  });
});

describe("extractLibraryVideoSources", () => {
  it("builds delivery sources with sd as low-res and the preview as thumbnail", () => {
    const ad = normalizeLibraryAd(VIDEO, 0);
    const sources = extractLibraryVideoSources(ad);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      key: "library:1178344137830897:video:0",
      origin: "ad_library",
      ad_archive_id: "1178344137830897",
      card_index: 0,
      source_url: ad.videos[0].hd_url,
      low_res_url: ad.videos[0].sd_url,
      thumbnail_url: ad.videos[0].preview_image_url,
    });
    expect(sources[0].label).toMatch(/TB SHOP|Video/);
  });

  it("falls back to the sd rendition as source when hd is missing", () => {
    const sources = extractLibraryVideoSources(normalizeLibraryAd(VIDEO_NO_HD, 0));
    expect(sources[0].source_url).toBe(sources[0].low_res_url);
  });

  it("emits one source per video card, keeping the card index", () => {
    const sources = extractLibraryVideoSources(normalizeLibraryAd(MIXED_CAROUSEL, 0));
    expect(sources).toHaveLength(1);
    expect(sources[0].card_index).toBe(1);
    expect(sources[0].key).toBe("library:9000000000000002:video:1");
  });
});

describe("libraryImageAssets", () => {
  it("lists top-level images and image cards, preferring the requested size", () => {
    const image = libraryImageAssets(normalizeLibraryAd(IMAGE, 0), "full");
    expect(image).toHaveLength(1);
    expect(image[0]).toMatchObject({ role: "primary", url: expect.stringMatching(/fbcdn/) });
    expect(image[0].url).not.toMatch(/stp=dst-jpg_s600x600/);

    const small = libraryImageAssets(normalizeLibraryAd(IMAGE, 0), "small");
    expect(small[0].url).toMatch(/stp=dst-jpg_s600x600/);

    const carousel = libraryImageAssets(normalizeLibraryAd(MIXED_CAROUSEL, 0), "full");
    expect(carousel.map((a) => a.role)).not.toContain("primary");
    expect(carousel.every((a) => a.role === "card" && a.card_index !== 1)).toBe(true);
  });
});

describe("mediaSummary", () => {
  it("summarizes raw items without normalizing everything", () => {
    expect(mediaSummary(CAROUSEL)).toMatchObject({ display_format: "CAROUSEL", video_count: 0, has_video: false });
    expect(mediaSummary(DCO).video_count).toBeGreaterThan(0);
    expect(mediaSummary(ERROR_ITEM)).toMatchObject({ display_format: null, image_count: 0, video_count: 0, has_video: false });
  });
});
