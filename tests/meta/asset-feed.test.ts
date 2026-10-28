import { describe, it, expect } from "vitest";
import { buildAssetGroups, buildDynamicFeed, buildLanguageFeed, buildPlacementFeed, buildSiteLinks } from "../../src/meta/asset-feed.js";

describe("buildDynamicFeed", () => {
  const base = {
    images: ["h1", "h2"],
    videos: [],
    primaryTexts: ["Uno", "Dos"],
    headlines: ["T1"],
    descriptions: [],
    callToActionTypes: ["LEARN_MORE", "SHOP_NOW"],
    links: [{ url: "https://example.com/", displayUrl: "example.com" }],
    format: "SINGLE_IMAGE" as const,
  };

  it("lays out the REGULAR feed Meta accepted for a dynamic-creative ad set", () => {
    expect(buildDynamicFeed(base)).toEqual({
      images: [{ hash: "h1" }, { hash: "h2" }],
      bodies: [{ text: "Uno" }, { text: "Dos" }],
      titles: [{ text: "T1" }],
      call_to_action_types: ["LEARN_MORE", "SHOP_NOW"],
      link_urls: [{ website_url: "https://example.com/", display_url: "example.com" }],
      ad_formats: ["SINGLE_IMAGE"],
      optimization_type: "REGULAR",
    });
  });

  it("takes videos with their thumbnail for the automatic format", () => {
    const feed = buildDynamicFeed({ ...base, images: ["h1"], videos: [{ videoId: "800123", thumbnailHash: "t1" }], format: "AUTOMATIC_FORMAT" });

    expect(feed.videos).toEqual([{ video_id: "800123", thumbnail_hash: "t1" }]);
    expect(feed.ad_formats).toEqual(["AUTOMATIC_FORMAT"]);
  });

  it.each([
    ["no link", { links: [] }, /link/],
    ["no button", { callToActionTypes: [] }, /call_to_action_types/],
    ["eleven images", { images: Array.from({ length: 11 }, (_, i) => `h${i}`) }, /10 images/],
    ["six primary texts", { primaryTexts: ["a", "b", "c", "d", "e", "f"] }, /5 primary texts/],
    ["a repeated text", { headlines: ["Same", "Same"] }, /repeat/],
    ["a headline over 255 characters", { headlines: ["x".repeat(256)] }, /255/],
    ["a single-image format without images", { images: [], videos: [{ videoId: "800123", thumbnailHash: "t" }] }, /SINGLE_IMAGE format needs/],
    ["a single-video format with images", { format: "SINGLE_VIDEO" as const, videos: [{ videoId: "800123", thumbnailHash: "t" }] }, /SINGLE_VIDEO format takes only videos/],
    ["a carousel of one image", { format: "CAROUSEL" as const, images: ["h1"] }, /2 images/],
    ["no media at all", { images: [], format: "AUTOMATIC_FORMAT" as const }, /image or video/],
  ])("refuses %s", (_label, extra, error) => {
    expect(() => buildDynamicFeed({ ...base, ...extra })).toThrow(error);
  });
});

describe("buildPlacementFeed", () => {
  const variants = [
    { placements: { publisherPlatforms: ["facebook"], facebookPositions: ["feed", "story"] }, imageHash: "fb" },
    { placements: { publisherPlatforms: ["instagram"], instagramPositions: ["stream", "story"] }, imageHash: "ig" },
  ];

  it("labels each variant's image and points a customization rule at it", () => {
    const feed = buildPlacementFeed({ variants, primaryText: "Text", headline: "Head", linkUrl: "https://example.com/", callToActionType: "LEARN_MORE" });

    expect(feed).toEqual({
      images: [{ hash: "fb", adlabels: [{ name: "placement_1" }] }, { hash: "ig", adlabels: [{ name: "placement_2" }] }],
      bodies: [{ text: "Text" }],
      titles: [{ text: "Head" }],
      link_urls: [{ website_url: "https://example.com/" }],
      call_to_action_types: ["LEARN_MORE"],
      ad_formats: ["SINGLE_IMAGE"],
      optimization_type: "PLACEMENT",
      asset_customization_rules: [
        { customization_spec: { publisher_platforms: ["facebook"], facebook_positions: ["feed", "story"] }, image_label: { name: "placement_1" } },
        { customization_spec: { publisher_platforms: ["instagram"], instagram_positions: ["stream", "story"] }, image_label: { name: "placement_2" } },
      ],
    });
  });

  it("uses video labels for video variants", () => {
    const feed = buildPlacementFeed({
      variants: variants.map((v, i) => ({ placements: v.placements, videoId: `80012${i}`, thumbnailHash: `t${i}` })),
      linkUrl: "https://example.com/",
      callToActionType: "LEARN_MORE",
    });

    expect(feed.ad_formats).toEqual(["SINGLE_VIDEO"]);
    expect(feed.videos).toEqual([
      { video_id: "800120", thumbnail_hash: "t0", adlabels: [{ name: "placement_1" }] },
      { video_id: "800121", thumbnail_hash: "t1", adlabels: [{ name: "placement_2" }] },
    ]);
    expect((feed.asset_customization_rules as Array<Record<string, unknown>>)[0].video_label).toEqual({ name: "placement_1" });
  });

  it.each([
    ["one variant", { variants: variants.slice(0, 1) }, /2 placement variants/],
    ["images mixed with videos", { variants: [variants[0], { ...variants[1], imageHash: undefined, videoId: "800123", thumbnailHash: "t" }] }, /all images or all videos/],
    ["a variant without media", { variants: [variants[0], { placements: variants[1].placements }] }, /placement_variants\[1\]/],
    ["a variant with both an image and a video", { variants: [{ ...variants[0], videoId: "800123", thumbnailHash: "t" }, { ...variants[1], imageHash: undefined, videoId: "800124", thumbnailHash: "t" }] }, /placement_variants\[0\].*either/],
    ["a thumbnail on an image variant", { variants: [{ ...variants[0], thumbnailHash: "t" }, variants[1]] }, /placement_variants\[0\].*thumbnail/],
    ["a placement Meta removed", { variants: [variants[0], { placements: { publisherPlatforms: ["instagram"], instagramPositions: ["explore"] }, imageHash: "ig" }] }, /explore/],
    ["no link", { linkUrl: "" }, /link_url/],
  ])("refuses %s", (_label, extra, error) => {
    expect(() => buildPlacementFeed({ variants, linkUrl: "https://example.com/", callToActionType: "LEARN_MORE", ...extra })).toThrow(error);
  });
});

describe("buildLanguageFeed", () => {
  const variants = [
    { locales: [23, 7], primaryText: "Hola", headline: "Titular", description: "Descripción" },
    { locales: [6], isDefault: true, primaryText: "Hello", headline: "Headline", description: "Description", linkUrl: "https://example.com/en" },
  ];

  it("labels each language's copy and link, with one default rule", () => {
    const feed = buildLanguageFeed({ variants, imageHash: "h1", linkUrl: "https://example.com/", callToActionType: "LEARN_MORE" });

    expect(feed).toMatchObject({
      images: [{ hash: "h1" }],
      bodies: [{ text: "Hola", adlabels: [{ name: "language_1" }] }, { text: "Hello", adlabels: [{ name: "language_2" }] }],
      titles: [{ text: "Titular", adlabels: [{ name: "language_1" }] }, { text: "Headline", adlabels: [{ name: "language_2" }] }],
      descriptions: [{ text: "Descripción", adlabels: [{ name: "language_1" }] }, { text: "Description", adlabels: [{ name: "language_2" }] }],
      link_urls: [{ website_url: "https://example.com/", adlabels: [{ name: "language_1" }] }, { website_url: "https://example.com/en", adlabels: [{ name: "language_2" }] }],
      call_to_action_types: ["LEARN_MORE"],
      ad_formats: ["SINGLE_IMAGE"],
      optimization_type: "LANGUAGE",
    });
    const rules = feed.asset_customization_rules as Array<Record<string, unknown>>;
    expect(rules[0]).toEqual({ customization_spec: { locales: [23, 7] }, body_label: { name: "language_1" }, title_label: { name: "language_1" }, description_label: { name: "language_1" }, link_url_label: { name: "language_1" } });
    expect(rules[1]).toMatchObject({ is_default: true, customization_spec: { locales: [6] } });
  });

  it.each([
    ["no default language", { variants: variants.map((v) => ({ ...v, isDefault: false })) }, /exactly one default/],
    ["two default languages", { variants: variants.map((v) => ({ ...v, isDefault: true })) }, /exactly one default/],
    ["a language without a description, which Meta refuses (1885817)", { variants: [{ ...variants[0], description: "" }, variants[1]] }, /description/],
    ["one language", { variants: variants.slice(1) }, /2 language variants/],
    ["no media", { imageHash: undefined }, /image_hash or video_id/],
  ])("refuses %s", (_label, extra, error) => {
    expect(() => buildLanguageFeed({ variants, imageHash: "h1", linkUrl: "https://example.com/", callToActionType: "LEARN_MORE", ...extra })).toThrow(error);
  });
});

describe("buildSiteLinks", () => {
  it("builds the site links spec Meta accepted", () => {
    expect(buildSiteLinks([{ title: "Shoes", url: "https://example.com/shoes", imageHash: "h1" }, { title: "Bags", url: "https://example.com/bags" }])).toEqual({
      site_links_spec: [
        { site_link_title: "Shoes", site_link_url: "https://example.com/shoes", site_link_image_hash: "h1" },
        { site_link_title: "Bags", site_link_url: "https://example.com/bags" },
      ],
    });
  });

  it("refuses a link without a title or a URL", () => {
    expect(() => buildSiteLinks([{ title: "", url: "https://example.com/" }])).toThrow(/site_links\[0\]/);
  });
});

describe("buildAssetGroups", () => {
  const group = {
    imageHashes: ["h1", "h2"],
    videoIds: ["800123"],
    primaryTexts: ["Uno", "Dos"],
    headlines: ["Titular"],
    descriptions: ["Desc"],
    callToAction: { type: "SHOP_NOW", link: "https://example.com/" },
  };

  it("builds the flexible format groups Meta accepted on a Sales ad", () => {
    expect(buildAssetGroups([group])).toEqual({
      groups: [{
        images: [{ hash: "h1" }, { hash: "h2" }],
        videos: [{ video_id: "800123" }],
        texts: [
          { text: "Uno", text_type: "primary_text" }, { text: "Dos", text_type: "primary_text" },
          { text: "Titular", text_type: "headline" }, { text: "Desc", text_type: "description" },
        ],
        call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/" } },
      }],
    });
  });

  it.each([
    ["a group without media", [{ ...group, imageHashes: [], videoIds: [] }], /groups\[0\].*image or video/],
    ["groups with different buttons", [group, { ...group, callToAction: { type: "LEARN_MORE", link: "https://example.com/" } }], /same button/],
    ["six primary texts in a group", [{ ...group, primaryTexts: ["a", "b", "c", "d", "e", "f"] }], /5 primary texts/],
    ["no group", [], /at least one group/],
  ])("refuses %s", (_label, groups, error) => {
    expect(() => buildAssetGroups(groups)).toThrow(error);
  });
});
