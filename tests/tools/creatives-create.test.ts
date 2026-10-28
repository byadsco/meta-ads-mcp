import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
  fetchCallSummary,
} from "../setup.js";

// Characterization of the request body ads_create_ad_creative sends today, so
// the shared creative builder can replace the inline one without drift.

const EMPTY_INPUT = {
  account_id: "act_123",
  name: "Creative",
  page_id: undefined,
  object_story_id: undefined,
  instagram_actor_id: undefined,
  source_instagram_media_id: undefined,
  image_hash: undefined,
  image_url: undefined,
  video_id: undefined,
  link_url: undefined,
  message: undefined,
  headline: undefined,
  description: undefined,
  call_to_action_type: undefined,
  url_tags: undefined,
};

function createHandler() {
  const server = createMockMcpServer();
  registerCreativeTools(server as never);
  const tool = server._registeredTools.find((t) => t.name === "ads_create_ad_creative");
  if (!tool) throw new Error("ads_create_ad_creative not registered");
  return tool.handler;
}

function stubCreateAndReadBack(postId = "6001_9001") {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
    .mockResolvedValueOnce(mockFetchResponse({ id: "4100", effective_object_story_id: postId })));
}

function sentBody(): Record<string, string> {
  const init = vi.mocked(fetch).mock.calls[0][1];
  return Object.fromEntries(new URLSearchParams(init?.body as string));
}

describe("ads_create_ad_creative request body", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds a single-image link ad inside object_story_spec.link_data", async () => {
    stubCreateAndReadBack();
    const result = await createHandler()({
      ...EMPTY_INPUT,
      name: "Image ad",
      page_id: "6001",
      instagram_actor_id: "17841400000000001",
      image_hash: "abc123hash",
      link_url: "https://example.com/landing",
      message: "Primary text",
      headline: "Headline",
      description: "Description",
      call_to_action_type: "SIGN_UP",
      url_tags: "utm_source=meta",
    }) as { content: Array<{ text: string }> };

    expect(fetchCallSummary()).toEqual(["POST /act_123/adcreatives", "GET /4100"]);
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["contextual_multi_ads", "degrees_of_freedom_spec", "name", "object_story_spec", "url_tags"]);
    expect(body.name).toBe("Image ad");
    expect(body.url_tags).toBe("utm_source=meta");
    expect(JSON.parse(body.object_story_spec)).toEqual({
      page_id: "6001",
      link_data: {
        image_hash: "abc123hash",
        link: "https://example.com/landing",
        message: "Primary text",
        name: "Headline",
        description: "Description",
        call_to_action: { type: "SIGN_UP", value: { link: "https://example.com/landing" } },
      },
      instagram_user_id: "17841400000000001",
    });
    expect(result.content[0].text).toContain("Post ID: 6001_9001");
  });

  it("omits the button when no call_to_action_type is given for a link ad", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      link_url: "https://example.com",
      message: "Primary text",
    });

    expect(JSON.parse(sentBody().object_story_spec)).toEqual({
      page_id: "6001",
      link_data: { image_hash: "abc123hash", link: "https://example.com", message: "Primary text" },
    });
  });

  it("builds a video ad inside video_data and defaults the button to LEARN_MORE when only a link is given", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      video_id: "800123",
      image_hash: "thumbhash",
      link_url: "https://example.com/video",
      message: "Video text",
      headline: "Video headline",
      description: "Video description",
    });

    expect(JSON.parse(sentBody().object_story_spec)).toEqual({
      page_id: "6001",
      video_data: {
        video_id: "800123",
        message: "Video text",
        image_hash: "thumbhash",
        title: "Video headline",
        link_description: "Video description",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/video" } },
      },
    });
  });

  it("promotes an existing Facebook post by object_story_id and ignores copy, link and button", async () => {
    stubCreateAndReadBack("6001_7777");
    await createHandler()({
      ...EMPTY_INPUT,
      name: "Boost",
      object_story_id: "6001_7777",
      instagram_actor_id: "17841400000000001",
      message: "Ignored",
      link_url: "https://example.com",
      call_to_action_type: "LEARN_MORE",
    });

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(["contextual_multi_ads", "degrees_of_freedom_spec", "instagram_user_id", "name", "object_story_id"]);
    expect(body.object_story_id).toBe("6001_7777");
    expect(body.instagram_user_id).toBe("17841400000000001");
  });

  it("promotes an existing Instagram post and keeps its button on the creative", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      name: "IG boost",
      page_id: "6001",
      instagram_actor_id: "17841400000000001",
      source_instagram_media_id: "17900000000000001",
      link_url: "https://example.com/ig",
      call_to_action_type: "SHOP_NOW",
      message: "Ignored",
      image_hash: "ignoredhash",
    });

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual([
      "call_to_action", "contextual_multi_ads", "degrees_of_freedom_spec", "instagram_user_id", "name", "object_id",
      "source_instagram_media_id",
    ]);
    expect(body.object_id).toBe("6001");
    expect(body.source_instagram_media_id).toBe("17900000000000001");
    expect(JSON.parse(body.call_to_action)).toEqual({ type: "SHOP_NOW", value: { link: "https://example.com/ig" } });
  });

  it("strips a leading '?' from url_tags", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      link_url: "https://example.com",
      url_tags: "?utm_source=meta&utm_medium=paid",
    });

    expect(sentBody().url_tags).toBe("utm_source=meta&utm_medium=paid");
  });

  it("sends several texts as a DEGREES_OF_FREEDOM asset feed, the shape Ads Manager uses", async () => {
    stubCreateAndReadBack();
    const result = await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      link_url: "https://example.com",
      primary_texts: ["One", "Two", "Three"],
      headlines: ["Head one", "Head two"],
      descriptions: ["Desc"],
      call_to_action_type: "PLAY_GAME",
    }) as { content: Array<{ text: string }> };

    const body = sentBody();
    expect(JSON.parse(body.object_story_spec)).toEqual({
      page_id: "6001",
      link_data: {
        image_hash: "abc123hash",
        link: "https://example.com",
        call_to_action: { type: "PLAY_GAME", value: { link: "https://example.com" } },
      },
    });
    expect(JSON.parse(body.asset_feed_spec)).toEqual({
      bodies: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
      titles: [{ text: "Head one" }, { text: "Head two" }],
      descriptions: [{ text: "Desc" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
    expect(result.content[0].text).toContain("3 primary text(s), 2 headline(s), 1 description(s)");
  });

  it("refuses a single field together with its list, before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      message: "One",
      primary_texts: ["Two", "Three"],
    })).rejects.toThrow(/either message or primary_texts/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("warns that copy is ignored when promoting an existing post", async () => {
    stubCreateAndReadBack("6001_7777");
    const result = await createHandler()({
      ...EMPTY_INPUT,
      object_story_id: "6001_7777",
      primary_texts: ["Ignored", "Also ignored"],
    }) as { content: Array<{ text: string }> };

    expect(sentBody().asset_feed_spec).toBeUndefined();
    expect(result.content[0].text).toMatch(/Ignored the ad copy/);
  });

  it("says the post does not exist yet when Meta has not created it", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
      .mockResolvedValueOnce(mockFetchResponse({ id: "4100" })));
    const result = await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      primary_texts: ["One", "Two"],
    }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toMatch(/Post ID: not created yet/);
  });

  it("turns Advantage+ creative features and multi-advertiser ads off unless asked", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
      .mockResolvedValueOnce(mockFetchResponse({
        id: "4100",
        degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: "OPT_OUT" } } },
      })));
    const result = await createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "abc123hash" }) as { content: Array<{ text: string }> };

    const body = sentBody();
    const features = JSON.parse(body.degrees_of_freedom_spec).creative_features_spec as Record<string, { enroll_status: string }>;
    expect(Object.keys(features)).toContain("text_optimizations");
    expect(new Set(Object.values(features).map((f) => f.enroll_status))).toEqual(new Set(["OPT_OUT"]));
    expect(JSON.parse(body.contextual_multi_ads)).toEqual({ enroll_status: "OPT_OUT" });
    expect(result.content[0].text).toContain("Advantage+ creative features on: none.");
    expect(result.content[0].text).toContain("Multi-advertiser ads: off.");
  });

  it("opts in only the features the caller lists", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      advantage_creative: { text_optimizations: "OPT_IN" },
      multi_advertiser_ads: true,
    });

    const body = sentBody();
    const features = JSON.parse(body.degrees_of_freedom_spec).creative_features_spec as Record<string, { enroll_status: string }>;
    expect(features.text_optimizations).toEqual({ enroll_status: "OPT_IN" });
    expect(features.image_touchups).toEqual({ enroll_status: "OPT_OUT" });
    expect(JSON.parse(body.contextual_multi_ads)).toEqual({ enroll_status: "OPT_IN" });
  });

  it("refuses the deprecated standard_enhancements before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      advantage_creative: { standard_enhancements: "OPT_IN" },
    })).rejects.toThrow(/standard_enhancements is deprecated/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("accepts PLAY_GAME and rejects headlines over 255 characters in the schema", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const schema = server._registeredTools.find((t) => t.name === "ads_create_ad_creative")!.schema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

    expect(schema.call_to_action_type.safeParse("PLAY_GAME").success).toBe(true);
    expect(schema.headlines.safeParse(["h".repeat(255)]).success).toBe(true);
    expect(schema.headlines.safeParse(["h".repeat(256)]).success).toBe(false);
    expect(schema.primary_texts.safeParse(["1", "2", "3", "4", "5", "6"]).success).toBe(false);
    expect(schema.primary_texts.safeParse(["   ", "Texto"]).success).toBe(false);
    expect(schema.headlines.safeParse([" "]).success).toBe(false);
  });

  it("publishes the headline length limit in the input JSON Schema clients see", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const schema = server._registeredTools.find((t) => t.name === "ads_create_ad_creative")!.schema as Record<string, z.ZodType>;

    const published = z.toJSONSchema(schema.headlines, { io: "input" }) as { items?: { maxLength?: number } };
    expect(published.items?.maxLength).toBe(255);
  });

  it("requires page_id when building from scratch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createHandler()({ ...EMPTY_INPUT, image_hash: "abc123hash" }))
      .rejects.toThrow(/page_id is required/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("ads_create_ad_creative carousels and destinations", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a carousel's cards, display link and card ordering", async () => {
    stubCreateAndReadBack();

    const result = await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      link_url: "https://example.com/",
      message: "Swipe",
      display_link: "example.com",
      call_to_action_type: "SHOP_NOW",
      cards: [
        { image_hash: "h1", headline: "One", link_url: "https://example.com/1" },
        { video_id: "800123", image_hash: "thumb", headline: "Two" },
      ],
      multi_share_optimized: false,
    }) as { content: Array<{ text: string }> };

    const linkData = JSON.parse(sentBody().object_story_spec).link_data;
    expect(linkData).toMatchObject({ link: "https://example.com/", message: "Swipe", caption: "example.com", multi_share_optimized: false });
    expect(linkData.child_attachments).toHaveLength(2);
    expect(linkData.child_attachments[1]).toMatchObject({ video_id: "800123", image_hash: "thumb", call_to_action: { type: "SHOP_NOW" } });
    expect(result.content[0].text).toContain("Carousel: 2 cards");
  });

  it("opens a lead form from the ad's button", async () => {
    stubCreateAndReadBack();

    await createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "h", message: "Sign up", destination: { type: "lead_form", lead_form_id: "7001" } });

    expect(JSON.parse(sentBody().object_story_spec).link_data).toMatchObject({
      link: "http://fb.me/", call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "7001" } },
    });
  });

  it("calls a phone number", async () => {
    stubCreateAndReadBack();

    await createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "h", link_url: "https://example.com/", destination: { type: "call", phone_number: "+573001234567" } });

    expect(JSON.parse(sentBody().object_story_spec).link_data.call_to_action).toEqual({ type: "CALL_NOW", value: { link: "tel:+573001234567" } });
  });

  it("refuses a card image URL that points inside a private network, before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(createHandler()({
      ...EMPTY_INPUT, page_id: "6001", link_url: "https://example.com/",
      cards: [{ image_hash: "h1" }, { image_url: "http://169.254.169.254/latest/meta-data" }],
    })).rejects.toThrow(/cards\[1\]/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed card video_id", { link_url: "https://example.com/", cards: [{ image_hash: "h1" }, { video_id: "1/../me", image_hash: "t" }] }, /video/],
    ["a malformed lead_form_id", { image_hash: "h", destination: { type: "lead_form", lead_form_id: "x/../me" } }, /lead_form/],
    ["a destination on a promoted post", { object_story_id: "6001_9001", destination: { type: "whatsapp" } }, /destination/],
    ["cards on a promoted post", { object_story_id: "6001_9001", cards: [{ image_hash: "h1" }, { image_hash: "h2" }] }, /cards/],
  ])("refuses %s before calling Meta", async (_label, extra, error) => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(createHandler()({ ...EMPTY_INPUT, page_id: "6001", ...extra })).rejects.toThrow(error);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("publishes the card count and phone format in the input schema", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const schema = z.object(server._registeredTools.find((t) => t.name === "ads_create_ad_creative")!.schema as z.ZodRawShape);

    expect(schema.safeParse({ account_id: "act_1", name: "c", cards: [{ image_hash: "h" }] }).success).toBe(false);
    expect(schema.safeParse({ account_id: "act_1", name: "c", destination: { type: "call", phone_number: "300 123" } }).success).toBe(false);
    expect(schema.safeParse({ account_id: "act_1", name: "c", destination: { type: "instagram_direct" } }).success).toBe(true);
  });
});

describe("ads_create_ad_creative dynamic creative, versions, music and site links", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const DYNAMIC = {
    image_hashes: ["h1", "h2"],
    videos: [{ video_id: "800123", thumbnail_hash: "t1" }],
    primary_texts: ["Uno", "Dos"],
    headlines: ["T1"],
    call_to_action_types: ["LEARN_MORE", "SHOP_NOW"],
    links: [{ url: "https://example.com/", display_url: "example.com" }],
    format: "AUTOMATIC_FORMAT",
  };
  const PLACEMENTS = [
    { placements: { publisher_platforms: ["facebook"], facebook_positions: ["feed"] }, image_hash: "fb" },
    { placements: { publisher_platforms: ["instagram"], instagram_positions: ["stream", "story"] }, image_hash: "ig" },
  ];
  const LANGUAGES = [
    { locales: [23], primary_text: "Hola", headline: "Titular", description: "Desc" },
    { locales: [6], default: true, primary_text: "Hello", headline: "Headline", description: "Desc" },
  ];

  it("sends a dynamic creative as the page identity plus a REGULAR feed, with no link data", async () => {
    stubCreateAndReadBack();

    const result = await createHandler()({ ...EMPTY_INPUT, page_id: "6001", instagram_actor_id: "17841400000000001", dynamic_creative: DYNAMIC }) as { content: Array<{ text: string }> };

    const body = sentBody();
    expect(JSON.parse(body.object_story_spec)).toEqual({ page_id: "6001", instagram_user_id: "17841400000000001" });
    expect(JSON.parse(body.asset_feed_spec)).toMatchObject({ optimization_type: "REGULAR", ad_formats: ["AUTOMATIC_FORMAT"], videos: [{ video_id: "800123", thumbnail_hash: "t1" }] });
    expect(result.content[0].text).toContain("is_dynamic_creative");
  });

  it("sends placement versions with the ad's own copy, link and button", async () => {
    stubCreateAndReadBack();

    await createHandler()({ ...EMPTY_INPUT, page_id: "6001", message: "Text", link_url: "https://example.com/", placement_variants: PLACEMENTS });

    const feed = JSON.parse(sentBody().asset_feed_spec);
    expect(feed).toMatchObject({ optimization_type: "PLACEMENT", bodies: [{ text: "Text" }], call_to_action_types: ["LEARN_MORE"] });
    expect(feed.asset_customization_rules).toHaveLength(2);
  });

  it("sends language versions over the ad's image", async () => {
    stubCreateAndReadBack();

    await createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "h1", link_url: "https://example.com/", call_to_action_type: "SIGN_UP", language_variants: LANGUAGES });

    const feed = JSON.parse(sentBody().asset_feed_spec);
    expect(feed).toMatchObject({ optimization_type: "LANGUAGE", images: [{ hash: "h1" }], call_to_action_types: ["SIGN_UP"] });
    expect(feed.asset_customization_rules[1]).toMatchObject({ is_default: true, customization_spec: { locales: [6] } });
  });

  it("lets Meta add music to an image ad", async () => {
    stubCreateAndReadBack();

    await createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "h1", link_url: "https://example.com/", message: "Text", music: true });

    const body = sentBody();
    expect(JSON.parse(body.asset_feed_spec)).toEqual({ audios: [{ type: "random" }] });
    expect(JSON.parse(body.object_story_spec).link_data).toMatchObject({ image_hash: "h1", message: "Text" });
  });

  it("adds site links and turns on the feature that shows them", async () => {
    stubCreateAndReadBack();

    await createHandler()({
      ...EMPTY_INPUT, page_id: "6001", image_hash: "h1", link_url: "https://example.com/",
      site_links: [{ title: "Shoes", url: "https://example.com/shoes", image_hash: "h2" }, { title: "Bags", url: "https://example.com/bags" }],
    });

    const body = sentBody();
    expect(JSON.parse(body.creative_sourcing_spec).site_links_spec).toHaveLength(2);
    expect(JSON.parse(body.degrees_of_freedom_spec).creative_features_spec.site_extensions).toEqual({ enroll_status: "OPT_IN" });
  });

  it.each([
    ["two layouts at once", { image_hash: undefined, dynamic_creative: DYNAMIC, placement_variants: PLACEMENTS }, /one of/],
    ["a dynamic creative with the ad's own image", { image_hash: "h0", dynamic_creative: DYNAMIC }, /dynamic_creative/],
    ["placement versions with several primary texts", { link_url: "https://example.com/", primary_texts: ["a", "b"], placement_variants: PLACEMENTS }, /primary_texts/],
    ["language versions with the ad's own copy", { image_hash: "h1", link_url: "https://example.com/", message: "x", language_variants: LANGUAGES }, /message/],
    ["music on a dynamic creative", { dynamic_creative: DYNAMIC, music: true }, /music/],
    ["site links on a carousel", { link_url: "https://example.com/", cards: [{ image_hash: "h1" }, { image_hash: "h2" }], site_links: [{ title: "A", url: "https://example.com/a" }] }, /site_links/],
    ["site links with the feature turned off", { image_hash: "h1", site_links: [{ title: "A", url: "https://example.com/a" }], advantage_creative: { site_extensions: "OPT_OUT" } }, /site_extensions/],
    ["a malformed video in a dynamic creative", { dynamic_creative: { ...DYNAMIC, videos: [{ video_id: "1/../me", thumbnail_hash: "t" }] } }, /video/],
    ["music on a promoted post", { object_story_id: "6001_9001", music: true }, /music/],
    ["carousel settings on a dynamic creative", { dynamic_creative: { ...DYNAMIC, format: "CAROUSEL" }, multi_share_optimized: false }, /multi_share_optimized/],
    ["carousel settings on placement versions", { link_url: "https://example.com/", placement_variants: PLACEMENTS, multi_share_end_card: false }, /multi_share_end_card/],
    ["carousel settings on language versions", { image_hash: "h1", link_url: "https://example.com/", language_variants: LANGUAGES, multi_share_optimized: true }, /multi_share_optimized/],
  ])("refuses %s before calling Meta", async (_label, extra, error) => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(createHandler()({ ...EMPTY_INPUT, page_id: "6001", ...extra })).rejects.toThrow(error);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("ads_create_ad_creative advanced_creative_fields", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends allowed creative fields this tool does not model, text as is and objects as JSON", async () => {
    stubCreateAndReadBack();

    await createHandler()({
      ...EMPTY_INPUT, page_id: "6001", image_hash: "h", link_url: "https://example.com/",
      advanced_creative_fields: { applink_treatment: "web_only", branded_content: { ad_format: 1 } },
    });

    const body = sentBody();
    expect(body.applink_treatment).toBe("web_only");
    expect(JSON.parse(body.branded_content)).toEqual({ ad_format: 1 });
  });

  it.each([
    ["a field this tool builds itself", { object_story_spec: { page_id: "1" } }, /object_story_spec/],
    ["a field outside the allowed list", { access_token: "x" }, /access_token/],
    ["a value over 16 KB", { template_url_spec: { x: "y".repeat(17_000) } }, /16 KB/],
    ["a prototype key", JSON.parse('{"__proto__": {"object_story_spec": {}}}') as Record<string, unknown>, /__proto__/],
    ["a key that differs only in case", { Applink_Treatment: "web_only" }, /Applink_Treatment/],
    ["text under 16 KB in characters but over it in bytes", { template_url_spec: { x: "é".repeat(9_000) } }, /16 KB/],
  ])("refuses %s before calling Meta", async (_label, fields, error) => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(createHandler()({ ...EMPTY_INPUT, page_id: "6001", image_hash: "h", advanced_creative_fields: fields })).rejects.toThrow(error);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
