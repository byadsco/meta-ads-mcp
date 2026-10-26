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
