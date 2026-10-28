import { describe, it, expect } from "vitest";
import {
  ADVANTAGE_CREATIVE_FEATURES,
  buildFeatureSpec,
  buildStorySpec,
  dofFeedProblem,
} from "../../src/meta/creative-spec.js";

const NO_TEXT = { primaryTexts: [], headlines: [], descriptions: [] };

describe("buildStorySpec", () => {
  it("keeps one text of each kind inside link_data for an image ad", () => {
    const result = buildStorySpec({
      pageId: "6001",
      instagramUserId: "17841400000000001",
      imageHash: "abc123hash",
      linkUrl: "https://example.com",
      primaryTexts: ["Primary"],
      headlines: ["Headline"],
      descriptions: ["Description"],
      callToActionType: "SIGN_UP",
    });

    expect(result.assetFeedSpec).toBeUndefined();
    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      instagram_user_id: "17841400000000001",
      link_data: {
        image_hash: "abc123hash",
        link: "https://example.com",
        message: "Primary",
        name: "Headline",
        description: "Description",
        call_to_action: { type: "SIGN_UP", value: { link: "https://example.com" } },
      },
    });
  });

  it("uses picture for an image URL and sends no button unless a type is given", () => {
    const result = buildStorySpec({ pageId: "6001", imageUrl: "https://cdn.example.com/a.jpg", linkUrl: "https://example.com", ...NO_TEXT });
    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      link_data: { picture: "https://cdn.example.com/a.jpg", link: "https://example.com" },
    });
  });

  it("puts a video's description in link_description and defaults its button to LEARN_MORE", () => {
    const result = buildStorySpec({
      pageId: "6001",
      videoId: "800123",
      imageHash: "thumbhash",
      linkUrl: "https://example.com/video",
      primaryTexts: ["Video text"],
      headlines: ["Video headline"],
      descriptions: ["Video description"],
    });

    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      video_data: {
        video_id: "800123",
        image_hash: "thumbhash",
        message: "Video text",
        title: "Video headline",
        link_description: "Video description",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/video" } },
      },
    });
  });

  it("moves several texts into a DEGREES_OF_FREEDOM asset feed, leaving no copy in link_data", () => {
    const result = buildStorySpec({
      pageId: "6001",
      imageHash: "abc123hash",
      linkUrl: "https://example.com",
      primaryTexts: ["One", "Two", "Three"],
      headlines: ["Head one", "Head two"],
      descriptions: ["Desc"],
      callToActionType: "PLAY_GAME",
    });

    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      link_data: {
        image_hash: "abc123hash",
        link: "https://example.com",
        call_to_action: { type: "PLAY_GAME", value: { link: "https://example.com" } },
      },
    });
    expect(result.assetFeedSpec).toEqual({
      bodies: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
      titles: [{ text: "Head one" }, { text: "Head two" }],
      descriptions: [{ text: "Desc" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
  });

  it("builds the same feed for a video, keeping media and button in video_data", () => {
    const result = buildStorySpec({
      pageId: "6001",
      videoId: "800123",
      imageUrl: "https://cdn.example.com/thumb.jpg",
      linkUrl: "https://example.com",
      primaryTexts: ["One", "Two"],
      headlines: ["Head"],
      descriptions: [],
    });

    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      video_data: {
        video_id: "800123",
        image_url: "https://cdn.example.com/thumb.jpg",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
      },
    });
    expect(result.assetFeedSpec).toEqual({
      bodies: [{ text: "One" }, { text: "Two" }],
      titles: [{ text: "Head" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
  });

  it("drops repeated texts, which Meta rejects, and falls back to plain copy when one of each is left", () => {
    const result = buildStorySpec({
      pageId: "6001",
      imageHash: "abc123hash",
      primaryTexts: ["Same", " Same "],
      headlines: ["Head"],
      descriptions: [],
    });

    expect(result.assetFeedSpec).toBeUndefined();
    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      link_data: { image_hash: "abc123hash", message: "Same", name: "Head" },
    });
    expect(result.warnings).toEqual([expect.stringMatching(/repeated primary text/i)]);
  });

  it("drops blank options, so they never become an empty variant", () => {
    const result = buildStorySpec({ pageId: "6001", imageHash: "h", primaryTexts: ["   ", "Texto"], headlines: [], descriptions: [] });

    expect(result.assetFeedSpec).toBeUndefined();
    expect(result.objectStorySpec.link_data).toEqual({ image_hash: "h", message: "Texto" });
    expect(result.warnings).toEqual(["Dropped a blank primary text."]);
  });

  it("sends a single text exactly as given, whitespace included", () => {
    const result = buildStorySpec({ pageId: "6001", imageHash: "h", primaryTexts: ["\nTexto\n"], headlines: [" Head "], descriptions: [] });
    expect(result.objectStorySpec.link_data).toEqual({ image_hash: "h", message: "\nTexto\n", name: " Head " });
  });

  it("refuses a video without a thumbnail", () => {
    expect(() => buildStorySpec({ pageId: "6001", videoId: "800123", ...NO_TEXT }))
      .toThrow(/require image_hash or image_url as a thumbnail/);
  });

  it("warns, without failing, when copy is longer than placements show in full", () => {
    const result = buildStorySpec({
      pageId: "6001",
      imageHash: "abc123hash",
      primaryTexts: ["p".repeat(126)],
      headlines: ["h".repeat(41)],
      descriptions: ["d".repeat(31)],
    });

    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join(" ")).toMatch(/125/);
  });
});

describe("dofFeedProblem", () => {
  it("accepts a feed Meta accepts", () => {
    expect(dofFeedProblem({ bodies: [{ text: "A" }, { text: "B" }], titles: [{ text: "T" }] })).toBeUndefined();
  });

  it.each([
    ["all fields singular", { bodies: [{ text: "A" }], titles: [{ text: "T" }] }, /two or more texts/],
    ["a repeated text", { bodies: [{ text: "A" }, { text: " A " }] }, /repeats a text/],
    ["a blank text", { bodies: [{ text: "A" }, { text: "  " }] }, /blank text/],
    ["a title over 255 characters", { bodies: [{ text: "A" }, { text: "B" }], titles: [{ text: "t".repeat(256) }] }, /over 255/],
  ])("names %s", (_label, feed, problem) => {
    expect(dofFeedProblem(feed)).toMatch(problem);
  });
});

describe("buildFeatureSpec", () => {
  it("turns every known Advantage+ creative feature and multi-advertiser ads off by default", () => {
    const spec = buildFeatureSpec();
    const features = spec.degrees_of_freedom_spec.creative_features_spec;

    expect(Object.keys(features).sort()).toEqual([...ADVANTAGE_CREATIVE_FEATURES].sort());
    expect(new Set(Object.values(features).map((f) => f.enroll_status))).toEqual(new Set(["OPT_OUT"]));
    expect(spec.contextual_multi_ads).toEqual({ enroll_status: "OPT_OUT" });
  });

  it("lets the caller opt features in, including ones outside the known list", () => {
    const spec = buildFeatureSpec({ text_optimizations: "OPT_IN", music: "OPT_IN" }, true);
    const features = spec.degrees_of_freedom_spec.creative_features_spec;

    expect(features.text_optimizations).toEqual({ enroll_status: "OPT_IN" });
    expect(features.music).toEqual({ enroll_status: "OPT_IN" });
    expect(features.image_touchups).toEqual({ enroll_status: "OPT_OUT" });
    expect(spec.contextual_multi_ads).toEqual({ enroll_status: "OPT_IN" });
  });

  it("refuses standard_enhancements, which Meta rejects since v22", () => {
    expect(() => buildFeatureSpec({ standard_enhancements: "OPT_IN" })).toThrow(/standard_enhancements/);
  });
});

describe("buildStorySpec: carousels", () => {
  const card = (n: number, extra: Record<string, unknown> = {}) => ({ imageHash: `h${n}`, headline: `Card ${n}`, ...extra });

  it("lays the cards out as child_attachments, each with its own link and button", () => {
    const result = buildStorySpec({
      pageId: "6001",
      instagramUserId: "17841400000000001",
      linkUrl: "https://example.com/",
      primaryTexts: ["Swipe"],
      headlines: [],
      descriptions: [],
      callToActionType: "SHOP_NOW",
      displayLink: "example.com",
      cards: [
        card(1, { linkUrl: "https://example.com/1", description: "First" }),
        card(2, { callToActionType: "LEARN_MORE" }),
      ],
      multiShareOptimized: true,
      multiShareEndCard: false,
    });

    expect(result.assetFeedSpec).toBeUndefined();
    expect(result.objectStorySpec).toEqual({
      page_id: "6001",
      instagram_user_id: "17841400000000001",
      link_data: {
        link: "https://example.com/",
        message: "Swipe",
        caption: "example.com",
        multi_share_optimized: true,
        multi_share_end_card: false,
        child_attachments: [
          { image_hash: "h1", link: "https://example.com/1", name: "Card 1", description: "First", call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com/1" } } },
          { image_hash: "h2", link: "https://example.com/", name: "Card 2", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com/" } } },
        ],
      },
    });
  });

  it("takes a video card with its thumbnail, and an image URL card", () => {
    const result = buildStorySpec({
      pageId: "6001",
      linkUrl: "https://example.com/",
      ...NO_TEXT,
      cards: [{ videoId: "800123", imageHash: "thumb" }, { imageUrl: "https://cdn.example.com/b.jpg" }],
    });

    const cards = (result.objectStorySpec.link_data as { child_attachments: unknown[] }).child_attachments;
    expect(cards).toEqual([
      { video_id: "800123", image_hash: "thumb", link: "https://example.com/" },
      { picture: "https://cdn.example.com/b.jpg", link: "https://example.com/" },
    ]);
  });

  it("puts several primary texts of a carousel in a DEGREES_OF_FREEDOM feed", () => {
    const result = buildStorySpec({ pageId: "6001", linkUrl: "https://example.com/", primaryTexts: ["One", "Two"], headlines: [], descriptions: [], cards: [card(1), card(2)] });

    expect(result.assetFeedSpec).toEqual({ bodies: [{ text: "One" }, { text: "Two" }], optimization_type: "DEGREES_OF_FREEDOM" });
    expect((result.objectStorySpec.link_data as Record<string, unknown>).message).toBeUndefined();
  });

  it.each([
    ["one card, which Meta refuses (#194)", { cards: [card(1)] }, /2 to 10 cards/],
    ["eleven cards", { cards: Array.from({ length: 11 }, (_, i) => card(i)) }, /2 to 10 cards/],
    ["a card without media", { cards: [card(1), { headline: "No media" }] }, /cards\[1\].*image/],
    ["a video card without a thumbnail", { cards: [card(1), { videoId: "800123" }] }, /cards\[1\].*thumbnail/],
    ["media of the ad itself", { imageHash: "top", cards: [card(1), card(2)] }, /image_hash, image_url and video_id belong on the cards/],
    ["headlines of the ad itself", { headlines: ["H"], cards: [card(1), card(2)] }, /headline.*cards/],
    ["no link", { linkUrl: undefined, cards: [card(1), card(2)] }, /link_url/],
    ["another destination", { destination: { type: "call" as const, phoneNumber: "+573001234567" }, cards: [card(1), card(2)] }, /website/],
  ])("refuses a carousel with %s", (_label, extra, error) => {
    expect(() => buildStorySpec({ pageId: "6001", linkUrl: "https://example.com/", ...NO_TEXT, ...extra })).toThrow(error);
  });

  it("refuses carousel settings without cards", () => {
    expect(() => buildStorySpec({ pageId: "6001", imageHash: "h", linkUrl: "https://example.com/", ...NO_TEXT, multiShareOptimized: true })).toThrow(/cards/);
  });
});

describe("buildStorySpec: destinations", () => {
  const image = { pageId: "6001", imageHash: "h", primaryTexts: ["Text"], headlines: [], descriptions: [] };
  const linkData = (result: ReturnType<typeof buildStorySpec>) => result.objectStorySpec.link_data as Record<string, unknown>;

  it("opens a lead form, with Meta's placeholder link and a SIGN_UP button by default", () => {
    const result = buildStorySpec({ ...image, destination: { type: "lead_form", leadFormId: "7001" } });

    expect(linkData(result)).toMatchObject({ link: "http://fb.me/", call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "7001" } } });
  });

  it("opens a Messenger chat with a welcome message and ice breakers", () => {
    const result = buildStorySpec({
      ...image,
      callToActionType: "SEND_MESSAGE",
      destination: { type: "messenger", welcomeMessage: "Hi!", iceBreakers: [{ question: "Price?", response: "Let us tell you" }] },
    });

    const data = linkData(result);
    expect(data).toMatchObject({ link: "https://fb.com/messenger_doc/", call_to_action: { type: "SEND_MESSAGE", value: { app_destination: "MESSENGER" } } });
    expect(JSON.parse(data.page_welcome_message as string)).toMatchObject({
      type: "VISUAL_EDITOR",
      text_format: { customer_action_type: "ice_breakers", message: { text: "Hi!", ice_breakers: [{ title: "Price?", response: "Let us tell you" }] } },
    });
  });

  it("opens WhatsApp and Instagram Direct with the buttons Meta accepted", () => {
    expect(linkData(buildStorySpec({ ...image, destination: { type: "whatsapp" } }))).toMatchObject({
      link: "https://api.whatsapp.com/send", call_to_action: { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } },
    });
    expect(linkData(buildStorySpec({ ...image, instagramUserId: "17841400000000001", destination: { type: "instagram_direct" } }))).toMatchObject({
      link: "https://www.instagram.com", call_to_action: { type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } },
    });
  });

  it("calls a phone number, keeping the ad's own link", () => {
    const result = buildStorySpec({ ...image, linkUrl: "https://example.com/", destination: { type: "call", phoneNumber: "+573001234567" } });

    expect(linkData(result)).toMatchObject({ link: "https://example.com/", call_to_action: { type: "CALL_NOW", value: { link: "tel:+573001234567" } } });
  });

  it("puts a video's destination in its button", () => {
    const result = buildStorySpec({ ...image, imageHash: "thumb", videoId: "800123", destination: { type: "lead_form", leadFormId: "7001" } });

    expect(result.objectStorySpec.video_data).toMatchObject({ call_to_action: { type: "SIGN_UP", value: { lead_gen_form_id: "7001" } } });
  });

  it.each([
    ["a call without the ad's link", { destination: { type: "call" as const, phoneNumber: "+573001234567" } }, /link_url/],
    ["a phone number that is not in international format", { linkUrl: "https://example.com/", destination: { type: "call" as const, phoneNumber: "3001234567" } }, /\+/],
    ["Instagram Direct without an Instagram account", { destination: { type: "instagram_direct" as const } }, /instagram/i],
    ["a link with a lead form", { linkUrl: "https://example.com/", destination: { type: "lead_form" as const, leadFormId: "7001" } }, /link_url/],
    ["ice breakers without a welcome message", { destination: { type: "messenger" as const, iceBreakers: [{ question: "Q", response: "R" }] } }, /welcome_message/],
  ])("refuses %s", (_label, extra, error) => {
    expect(() => buildStorySpec({ ...image, ...extra })).toThrow(error);
  });
});
