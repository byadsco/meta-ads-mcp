import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  archiveIdOf,
  extractLibraryVideoSources,
  isAdLibraryErrorItem,
  isTemplateCopy,
  libraryImageAssets,
  libraryVideoAt,
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

describe("normalizeLibraryAd hostile input", () => {
  it("caps cards, media arrays and string lengths so a hostile record cannot balloon", () => {
    const cards = Array.from({ length: 5000 }, (_, i) => ({ title: "t" + i, original_image_url: "https://scontent.xx.fbcdn.net/" + i + ".jpg" }));
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        body: { text: "x".repeat(200_000) },
        title: "y".repeat(50_000),
        cards,
        images: Array.from({ length: 500 }, () => ({ original_image_url: "https://scontent.xx.fbcdn.net/a.jpg" })),
        videos: Array.from({ length: 500 }, () => ({ video_sd_url: "https://video.xx.fbcdn.net/a.mp4" })),
        extra_texts: Array.from({ length: 500 }, () => "z"),
      },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.cards.length).toBeLessThanOrEqual(30);
    expect(ad.images.length).toBeLessThanOrEqual(20);
    expect(ad.videos.length).toBeLessThanOrEqual(20);
    expect(ad.extra_texts.length).toBeLessThanOrEqual(20);
    expect((ad.copy.body as string).length).toBeLessThanOrEqual(4100);
    expect(ad.copy.body).toMatch(/\[truncated\]$/);
    expect(ad.truncated).toEqual(expect.arrayContaining(["cards", "images", "videos", "copy.body"]));
    expect(ad.media_summary.image_count).toBe(500 + 5000);
    expect(JSON.stringify(ad).length).toBeLessThan(300_000);
  });

  it("skips cards that are not objects instead of materializing empty ones", () => {
    const raw = { ad_archive_id: "1234567890", snapshot: { cards: [null, 5, "x", { title: "real" }] } } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.cards).toHaveLength(1);
    expect(ad.cards[0]).toMatchObject({ index: 3, title: "real" });
    expect(mediaSummary(raw)).toMatchObject({ image_count: 0, video_count: 0 });
  });

  it("returns null dates for timestamps outside the representable range", () => {
    for (const bad of [8640000000001, 1e308, -5, "soon"]) {
      const ad = normalizeLibraryAd({ ad_archive_id: "1234567890", start_date: bad, end_date: bad } as AdLibraryRawItem, 0);
      expect(ad.start_date).toBeNull();
      expect(ad.end_date).toBeNull();
    }
  });

  it("accepts the legacy adArchiveID / pageName aliases and numeric ids", () => {
    const legacy = { adArchiveID: 12345678901, pageName: "Legacy", snapshot: { body: { markup: { __html: "<p>Copy</p>" } } } } as AdLibraryRawItem;
    expect(isAdLibraryErrorItem(legacy)).toBe(false);
    const ad = normalizeLibraryAd(legacy, 0);
    expect(ad.ad_archive_id).toBe("12345678901");
    expect(ad.page.name).toBe("Legacy");
  });

  it("ignores prototype-polluting keys in raw records", () => {
    const raw = JSON.parse("{\"ad_archive_id\":\"1234567890\",\"__proto__\":{\"polluted\":true},\"snapshot\":{\"__proto__\":{\"x\":1}}}") as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(ad.details).toBeUndefined();
  });
});

describe("normalizeLibraryAd round-2 hardening", () => {
  it("strips legacy html bodies in linear time even for pathological markup", () => {
    // No closing ">" anywhere: a backtracking tag regex is quadratic on this input.
    const raw = { ad_archive_id: "1234567890", snapshot: { body: { markup: { __html: "<".repeat(200_000) } } } } as AdLibraryRawItem;
    const started = Date.now();
    const ad = normalizeLibraryAd(raw, 0);
    expect(Date.now() - started).toBeLessThan(200);
    expect((ad.copy.body ?? "").length).toBeLessThanOrEqual(4100);
  });

  it("only accepts safe-integer numeric ids", () => {
    expect(archiveIdOf({ ad_archive_id: 9007199254740993 })).toBeNull();
    expect(archiveIdOf({ ad_archive_id: 1234567890123 })).toBe("1234567890123");
    expect(archiveIdOf({ ad_archive_id: 12.5 })).toBeNull();
  });

  it("reports how many videos and images are actually available after the caps", () => {
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: Array.from({ length: 25 }, () => ({ video_sd_url: "https://video.xx.fbcdn.net/a.mp4" })) },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.media_summary.video_count).toBe(25);
    expect(ad.media_summary.videos_available).toBe(20);
    expect(extractLibraryVideoSources(ad)).toHaveLength(20);
  });
});

describe("normalizeLibraryAd round-3 hardening", () => {
  it("omits any media or link url longer than the url limit instead of truncating it", () => {
    const long = "https://scontent.xx.fbcdn.net/" + "a".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        link_url: long,
        page_profile_picture_url: long,
        images: [{ original_image_url: long, resized_image_url: "https://scontent.xx.fbcdn.net/ok.jpg" }],
        videos: [{ video_hd_url: long, video_sd_url: "https://video.xx.fbcdn.net/ok.mp4", video_preview_image_url: long }],
        cards: [{ video_sd_url: long }],
      },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.copy.link_url).toBeNull();
    expect(ad.page.profile_picture_url).toBeNull();
    expect(ad.images[0]).toEqual({ original_url: null, resized_url: "https://scontent.xx.fbcdn.net/ok.jpg" });
    expect(ad.videos[0]).toMatchObject({ hd_url: null, sd_url: "https://video.xx.fbcdn.net/ok.mp4", preview_image_url: null, omitted_urls: ["video_hd_url", "video_preview_image_url"] });
    expect(ad.cards[0].video).toBeNull();
    expect(ad.truncated.some((t) => /url omitted/.test(t))).toBe(true);
    expect(JSON.stringify(ad)).not.toContain("a".repeat(100));
  });

  it("keeps a literal > outside tags and reports when the html prefix was cut", () => {
    const ad = normalizeLibraryAd({ ad_archive_id: "1234567890", snapshot: { body: { markup: { __html: "<p>Save > 50% today</p>" } } } } as AdLibraryRawItem, 0);
    expect(ad.copy.body).toBe("Save > 50% today");

    const longHtml = "<b>x</b>".repeat(10_000) + "TAIL";
    const cut = normalizeLibraryAd({ ad_archive_id: "1234567890", snapshot: { body: { markup: { __html: longHtml } } } } as AdLibraryRawItem, 0);
    expect(cut.truncated).toContain("copy.body");
  });

  it("stops collecting media at the caps instead of materializing everything first", () => {
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        images: Array.from({ length: 200_000 }, () => ({ original_image_url: "https://scontent.xx.fbcdn.net/a.jpg" })),
        cards: Array.from({ length: 200_000 }, () => ({ title: "t", original_image_url: "https://scontent.xx.fbcdn.net/c.jpg" })),
      },
    } as AdLibraryRawItem;
    const started = Date.now();
    const ad = normalizeLibraryAd(raw, 0);
    expect(Date.now() - started).toBeLessThan(500);
    expect(ad.images).toHaveLength(20);
    expect(ad.cards).toHaveLength(30);
    expect(ad.truncated).toEqual(expect.arrayContaining(["images", "cards"]));
  });

  it("libraryVideoAt addresses a video beyond the presentation caps", () => {
    const raw = {
      ad_archive_id: "1234567890",
      page_name: "P",
      snapshot: { videos: Array.from({ length: 25 }, (_, i) => ({ video_sd_url: "https://video.xx.fbcdn.net/" + i + ".mp4" })) },
    } as AdLibraryRawItem;
    const source = libraryVideoAt(raw, 22);
    expect(source).toMatchObject({ card_index: 22, low_res_url: "https://video.xx.fbcdn.net/22.mp4", key: "library:1234567890:video:22" });
    expect(libraryVideoAt(raw, 25)).toBeUndefined();
  });
});

describe("round-4 hardening", () => {
  it("bounds source labels even on the indexed path with a huge page name", () => {
    const raw = {
      ad_archive_id: "1234567890",
      page_name: "P".repeat(100_000),
      snapshot: { videos: [{ video_sd_url: "https://video.xx.fbcdn.net/0.mp4" }] },
    } as AdLibraryRawItem;
    const direct = libraryVideoAt(raw, 0);
    expect(direct?.label.length).toBeLessThanOrEqual(220);
    const normalized = extractLibraryVideoSources(normalizeLibraryAd(raw, 0));
    expect(normalized[0].label.length).toBeLessThanOrEqual(220);
  });

  it("applies the url policy to ad_library_url and falls back to the canonical link", () => {
    const raw = { ad_archive_id: "1234567890", ad_library_url: "https://www.facebook.com/ads/library/?" + "q".repeat(9000) } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.ad_library_url).toBe("https://www.facebook.com/ads/library/?id=1234567890");
    expect(ad.truncated).toEqual(expect.arrayContaining([expect.stringMatching(/ad_library_url/)]));
  });

  it("tells the caller when a rendition url was omitted from a video source", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: [{ video_hd_url: long, video_sd_url: "https://video.xx.fbcdn.net/sd.mp4" }] },
    } as AdLibraryRawItem;
    const fromNormalized = extractLibraryVideoSources(normalizeLibraryAd(raw, 0));
    expect(fromNormalized[0].low_res_url).toBe("https://video.xx.fbcdn.net/sd.mp4");
    expect(fromNormalized[0].error).toMatch(/omitted/);
    const direct = libraryVideoAt(raw, 0);
    expect(direct?.error).toMatch(/omitted/);
  });
});

describe("round-5 hardening", () => {
  it("bounds the detail blocks copied from a record with thousands of transparency keys", () => {
    const raw: Record<string, unknown> = { ad_archive_id: "1234567890" };
    for (let i = 0; i < 5000; i++) raw["x" + i + "_transparency"] = { reach: "r".repeat(1000) };
    const ad = normalizeLibraryAd(raw as AdLibraryRawItem, 0);
    expect(Object.keys(ad.details ?? {}).length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(ad.details ?? {}).length).toBeLessThan(40_000);
  });

  it("attributes omission notes to the right video after invalid entries were skipped", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: [{}, { video_hd_url: long, video_sd_url: "https://video.xx.fbcdn.net/sd.mp4" }, { video_sd_url: "https://video.xx.fbcdn.net/ok.mp4" }] },
    } as AdLibraryRawItem;
    const sources = extractLibraryVideoSources(normalizeLibraryAd(raw, 0));
    expect(sources).toHaveLength(2);
    expect(sources[0].error).toMatch(/omitted/);
    expect(sources[1].error).toBeUndefined();
  });
});

describe("round-6 hardening", () => {
  it("bounds string lists (platforms, categories) before converting them", () => {
    const raw = {
      ad_archive_id: "1234567890",
      publisher_platform: Array.from({ length: 50_000 }, () => "x".repeat(50)),
      snapshot: { page_categories: Array.from({ length: 50_000 }, () => 0) },
    } as AdLibraryRawItem;
    const started = Date.now();
    const ad = normalizeLibraryAd(raw, 0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(ad.publisher_platforms.length).toBeLessThanOrEqual(20);
    expect(ad.page.categories.length).toBeLessThanOrEqual(20);
    expect(ad.truncated).toEqual(expect.arrayContaining(["publisher_platforms", "page.categories"]));
  });

  it("attaches omission notes only to the video they belong to", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      // First entry: only an overlong HD url, so the video is dropped entirely.
      // Second entry: a valid video with no omissions.
      snapshot: { videos: [{ video_hd_url: long }, { video_sd_url: "https://video.xx.fbcdn.net/ok.mp4" }] },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    const sources = extractLibraryVideoSources(ad);
    expect(sources).toHaveLength(1);
    expect(sources[0].error).toBeUndefined();
    expect(libraryVideoAt(raw, 0)?.error).toBeUndefined();
    expect(ad.truncated).toContain("videos[raw 0] dropped (renditions too long)");
  });

  it("keeps card indexes consistent between the normalized sources and libraryVideoAt beyond the caps", () => {
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        videos: Array.from({ length: 25 }, (_, i) => ({ video_sd_url: "https://video.xx.fbcdn.net/" + i + ".mp4" })),
        cards: [{ video_sd_url: "https://video.xx.fbcdn.net/card.mp4" }],
      },
    } as AdLibraryRawItem;
    const normalized = extractLibraryVideoSources(normalizeLibraryAd(raw, 0));
    const cardFromNormalized = normalized.find((s) => s.low_res_url?.endsWith("card.mp4"));
    expect(cardFromNormalized).toBeDefined();
    const direct = libraryVideoAt(raw, cardFromNormalized!.card_index as number);
    expect(direct?.low_res_url).toBe("https://video.xx.fbcdn.net/card.mp4");
    expect(direct?.key).toBe(cardFromNormalized!.key);
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

  it("emits one source per video card, addressed by its video selector (video_index)", () => {
    // The mixed carousel has an image card at 0 and its only video at card 1:
    // as the first video of the record it is selector 0, which is what
    // video_index=0 addresses on both the normalized and the direct path.
    const sources = extractLibraryVideoSources(normalizeLibraryAd(MIXED_CAROUSEL, 0));
    expect(sources).toHaveLength(1);
    expect(sources[0].card_index).toBe(0);
    expect(sources[0].key).toBe("library:9000000000000002:video:0");
    expect(libraryVideoAt(MIXED_CAROUSEL, 0)?.key).toBe(sources[0].key);
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

describe("round-7 hardening", () => {
  it("never feeds an oversized url to the expiry parser when summarizing", () => {
    const huge = "https://video.xx.fbcdn.net/v.mp4?oe=69617495&" + "a=0&".repeat(300_000);
    const onlyHuge = { ad_archive_id: "1234567890", snapshot: { videos: [{ video_sd_url: huge }] } } as AdLibraryRawItem;
    const started = Date.now();
    const summary = mediaSummary(onlyHuge);
    expect(Date.now() - started).toBeLessThan(200);
    expect(summary.video_count).toBe(1);
    expect(summary.expires_at).toBeUndefined();

    const withValid = {
      ad_archive_id: "1234567890",
      snapshot: { videos: [{ video_sd_url: huge }, { video_sd_url: "https://video.xx.fbcdn.net/ok.mp4?oe=69617495" }] },
    } as AdLibraryRawItem;
    expect(mediaSummary(withValid).expires_at).toBe(new Date(0x69617495 * 1000).toISOString());
  });

  it("bounds cta_type and impressions_text at normalization instead of at render time", () => {
    const raw = {
      ad_archive_id: "1234567890",
      impressions_with_index: { impressions_text: "i".repeat(2_000_000) },
      snapshot: { cta_type: "c".repeat(2_000_000) },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.copy.cta_type!.length).toBeLessThan(4100);
    expect(ad.impressions_text!.length).toBeLessThan(4100);
    expect(ad.truncated).toEqual(expect.arrayContaining(["copy.cta_type", "impressions_text"]));
  });

  it("keeps every announced selector addressable when an earlier video is dropped by the url policy", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        videos: [{ video_hd_url: long }, { video_sd_url: "https://video.xx.fbcdn.net/top.mp4" }],
        cards: [
          { original_image_url: "https://scontent.xx.fbcdn.net/c0.jpg" },
          { video_sd_url: "https://video.xx.fbcdn.net/a.mp4" },
          { video_sd_url: "https://video.xx.fbcdn.net/b.mp4" },
        ],
      },
    } as AdLibraryRawItem;
    const sources = extractLibraryVideoSources(normalizeLibraryAd(raw, 0));
    expect(sources.map((s) => s.low_res_url)).toEqual([
      "https://video.xx.fbcdn.net/top.mp4",
      "https://video.xx.fbcdn.net/a.mp4",
      "https://video.xx.fbcdn.net/b.mp4",
    ]);
    for (const source of sources) {
      expect(libraryVideoAt(raw, source.card_index as number)?.low_res_url).toBe(source.low_res_url);
    }
  });

  it("labels a video dropped by the url policy with its raw index, not an output position", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: [{ video_hd_url: long }, { video_sd_url: "https://video.xx.fbcdn.net/ok.mp4" }] },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.videos).toHaveLength(1);
    expect(ad.videos[0].sd_url).toBe("https://video.xx.fbcdn.net/ok.mp4");
    expect(ad.truncated.some((t) => t.includes("videos[raw 0]"))).toBe(true);
    expect(ad.truncated.some((t) => t.startsWith("videos[0]."))).toBe(false);
  });

  it("records per-item truncation in string lists and stops inspecting past a budget", () => {
    const raw = {
      ad_archive_id: "1234567890",
      publisher_platform: ["x".repeat(65)],
      snapshot: { page_categories: [...Array.from({ length: 500_000 }, () => null), "FACEBOOK"] },
    } as AdLibraryRawItem;
    const started = Date.now();
    const ad = normalizeLibraryAd(raw, 0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(ad.publisher_platforms[0]).toHaveLength(64);
    expect(ad.truncated.some((t) => t.startsWith("publisher_platforms"))).toBe(true);
    expect(ad.page.categories).toEqual([]);
    expect(ad.truncated).toContain("page.categories");
  });

  it("bounds the omission notes a record with many unusable videos can emit", () => {
    const long = "https://video.xx.fbcdn.net/" + "h".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: Array.from({ length: 200_000 }, () => ({ video_hd_url: long })) },
    } as AdLibraryRawItem;
    const started = Date.now();
    const ad = normalizeLibraryAd(raw, 0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ad.videos).toEqual([]);
    expect(ad.truncated.length).toBeLessThan(30);
  });
});

describe("round-8 hardening", () => {
  it("derives expires_at from any rendition within the url limit, not just the preferred one", () => {
    const huge = "https://video.xx.fbcdn.net/big.mp4?" + "a=0&".repeat(300_000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { videos: [{ video_sd_url: huge, video_hd_url: "https://video.xx.fbcdn.net/ok.mp4?oe=69617495" }] },
    } as AdLibraryRawItem;
    expect(mediaSummary(raw).expires_at).toBe(new Date(0x69617495 * 1000).toISOString());

    const imageRaw = {
      ad_archive_id: "1234567890",
      snapshot: { images: [{ original_image_url: huge, resized_image_url: "https://scontent.xx.fbcdn.net/ok.jpg?oe=69617495" }] },
    } as AdLibraryRawItem;
    expect(mediaSummary(imageRaw).expires_at).toBe(new Date(0x69617495 * 1000).toISOString());
  });

  it("bounds the notes and the walk for a record carrying thousands of unusable images", () => {
    const long = "https://scontent.xx.fbcdn.net/" + "i".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        images: [
          ...Array.from({ length: 10_000 }, () => ({ original_image_url: long, resized_image_url: long })),
          { original_image_url: "https://scontent.xx.fbcdn.net/ok.jpg" },
        ],
      },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.truncated.length).toBeLessThan(30);
    expect(ad.truncated.some((t) => t.includes("images[raw 0]"))).toBe(true);
    expect(ad.truncated).toContain("images");
  });

  it("labels a dropped image by its raw index so the note cannot point at a surviving one", () => {
    const long = "https://scontent.xx.fbcdn.net/" + "i".repeat(5000);
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: { images: [{ original_image_url: long, resized_image_url: long }, { original_image_url: "https://scontent.xx.fbcdn.net/ok.jpg" }] },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.images).toHaveLength(1);
    expect(ad.images[0].original_url).toBe("https://scontent.xx.fbcdn.net/ok.jpg");
    expect(ad.truncated.some((t) => t.includes("images[raw 0]"))).toBe(true);
    expect(ad.truncated.some((t) => t.startsWith("images[0]."))).toBe(false);
  });
});

describe("round-9 hardening", () => {
  it("does not spend the image budget on entries that are not objects", () => {
    const raw = {
      ad_archive_id: "1234567890",
      snapshot: {
        images: [...Array.from({ length: 5000 }, () => null), { original_image_url: "https://scontent.xx.fbcdn.net/ok.jpg" }],
      },
    } as AdLibraryRawItem;
    const ad = normalizeLibraryAd(raw, 0);
    expect(ad.images).toHaveLength(1);
    expect(ad.images[0].original_url).toBe("https://scontent.xx.fbcdn.net/ok.jpg");
    expect(ad.media_summary.images_available).toBe(1);
    expect(ad.truncated).not.toContain("images");
    expect(libraryImageAssets(ad, "full")).toHaveLength(1);
  });
});
