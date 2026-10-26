import { describe, it, expect } from "vitest";
import { planContentEdit, readCopy } from "../../src/meta/ad-content.js";
import type { AdCreative } from "../../src/meta/types/index.js";

const LINK = "https://example.com/";

function multiText(overrides: Partial<AdCreative> = {}): AdCreative {
  return {
    id: "4001",
    name: "Multi",
    effective_object_story_id: "6001_777",
    object_story_spec: {
      page_id: "6001",
      instagram_user_id: "17841400000000001",
      link_data: { link: LINK, image_hash: "h1", call_to_action: { type: "SIGN_UP" } },
    },
    asset_feed_spec: {
      bodies: [{ text: "Uno" }, { text: "Dos" }],
      titles: [{ text: "T1" }, { text: "T2" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    },
    url_tags: "utm_source=meta",
    ...overrides,
  };
}

function singleImage(overrides: Partial<AdCreative> = {}): AdCreative {
  return {
    id: "4002",
    name: "Single",
    effective_object_story_id: "6001_888",
    object_story_spec: {
      page_id: "6001",
      link_data: {
        link: LINK, image_hash: "h1", message: "Texto", name: "Titular", description: "Desc",
        call_to_action: { type: "LEARN_MORE", value: { link: LINK } },
      },
    },
    ...overrides,
  };
}

const parse = (value: string | undefined) => (value === undefined ? undefined : JSON.parse(value));

describe("readCopy", () => {
  it("reads text options from a DEGREES_OF_FREEDOM feed", () => {
    expect(readCopy(multiText())).toEqual({
      source: "text_options",
      copy: { primary: ["Uno", "Dos"], headlines: ["T1", "T2"], descriptions: [] },
    });
  });

  it("reads single copy from link_data and video_data", () => {
    expect(readCopy(singleImage())).toEqual({
      source: "link_data",
      copy: { primary: ["Texto"], headlines: ["Titular"], descriptions: ["Desc"] },
    });
    expect(readCopy({
      id: "1", name: "v", object_story_spec: { page_id: "6001", video_data: { video_id: "8", message: "M", title: "T", link_description: "D" } },
    })).toEqual({ source: "video_data", copy: { primary: ["M"], headlines: ["T"], descriptions: ["D"] } });
  });

  it("reads a promoted post's copy from the creative's body and title", () => {
    expect(readCopy({ id: "1", name: "p", effective_object_story_id: "6001_9", body: "Post text", title: "Post title" }))
      .toEqual({ source: "post", copy: { primary: ["Post text"], headlines: ["Post title"], descriptions: [] } });
  });

  it("declines carousels and dynamic creative feeds", () => {
    expect(readCopy(singleImage({ object_story_spec: { page_id: "6001", link_data: { child_attachments: [] } } })))
      .toEqual({ unsupported: expect.stringMatching(/carousel/) });
    expect(readCopy(multiText({ asset_feed_spec: { images: [{ hash: "a" }], bodies: [{ text: "x" }], optimization_type: "REGULAR" } })))
      .toEqual({ unsupported: expect.stringMatching(/dynamic creative/) });
  });
});

describe("planContentEdit — same post (route A)", () => {
  it("changes primary texts on the same post, keeping Facebook engagement", () => {
    const plan = planContentEdit(
      multiText({ degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" } } } }),
      { primary_texts: { remove: ["Dos"], add: ["Tres", "Cuatro"] } },
      false,
    );

    expect(plan.route).toBe("same_post");
    expect(plan.after.primary).toEqual(["Uno", "Tres", "Cuatro"]);
    expect(plan.social_proof).toEqual({ facebook: "kept", instagram: "reset" });
    expect(plan.body?.object_story_id).toBe("6001_777");
    expect(plan.body?.instagram_user_id).toBe("17841400000000001");
    expect(plan.body?.object_story_spec).toBeUndefined();
    expect(parse(plan.body?.asset_feed_spec)).toEqual({
      bodies: [{ text: "Uno" }, { text: "Tres" }, { text: "Cuatro" }],
      titles: [{ text: "T1" }, { text: "T2" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
    expect(plan.body?.url_tags).toBe("utm_source=meta");
    expect(parse(plan.body?.degrees_of_freedom_spec)).toEqual({ creative_features_spec: {} });
    expect(plan.warnings.join(" ")).toMatch(/headline options stop rotating/);
    expect(plan.warnings.join(" ")).toMatch(/standard_enhancements/);
  });

  it("also works for a single-text ad that ends with two primary texts", () => {
    const plan = planContentEdit(singleImage(), { primary_texts: { add: ["Otro texto"] } }, false);
    expect(plan.route).toBe("same_post");
    expect(parse(plan.body?.asset_feed_spec).bodies).toEqual([{ text: "Texto" }, { text: "Otro texto" }]);
  });

  it("applies a new url_tags value on the same post", () => {
    const plan = planContentEdit(multiText(), { primary_texts: { add: ["Tres"] }, url_tags: "utm_source=x" }, false);
    expect(plan.body?.url_tags).toBe("utm_source=x");
  });
});

describe("planContentEdit — new post", () => {
  it("refuses changes that need a new post unless allow_new_post is set", () => {
    const plan = planContentEdit(multiText(), { headlines: { set: ["Nuevo"] } }, false);
    expect(plan.route).toBeUndefined();
    expect(plan.reason).toMatch(/allow_new_post: true/);

    const single = planContentEdit(singleImage(), { primary_texts: { set: ["Otro"] } }, false);
    expect(single.reason).toMatch(/a single primary text needs a new post/);
  });

  it("rebuilds the spec with the copy as text options when several remain", () => {
    const plan = planContentEdit(multiText(), { headlines: { remove: ["T2"], add: ["T3"] } }, true);

    expect(plan.route).toBe("new_post");
    expect(plan.social_proof).toEqual({ facebook: "reset", instagram: "reset" });
    expect(plan.body?.object_story_id).toBeUndefined();
    expect(parse(plan.body?.object_story_spec)).toEqual(multiText().object_story_spec);
    expect(parse(plan.body?.asset_feed_spec)).toEqual({
      bodies: [{ text: "Uno" }, { text: "Dos" }],
      titles: [{ text: "T1" }, { text: "T3" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
  });

  it("puts the copy back in the spec when one text of each kind remains", () => {
    const plan = planContentEdit(multiText(), { primary_texts: { remove: ["Dos"] }, headlines: { set: ["Solo"] } }, true);
    expect(plan.body?.asset_feed_spec).toBeUndefined();
    expect(parse(plan.body?.object_story_spec).link_data).toEqual({
      link: LINK, image_hash: "h1", call_to_action: { type: "SIGN_UP" }, message: "Uno", name: "Solo",
    });
  });

  it("swaps link, button and image in the cloned spec", () => {
    const plan = planContentEdit(
      singleImage(),
      { link_url: "https://example.com/new", call_to_action_type: "PLAY_GAME", image_hash: "h2" },
      true,
    );
    expect(parse(plan.body?.object_story_spec).link_data).toEqual({
      link: "https://example.com/new",
      image_hash: "h2",
      message: "Texto",
      name: "Titular",
      description: "Desc",
      call_to_action: { type: "PLAY_GAME", value: { link: "https://example.com/new" } },
    });
  });

  it("keeps a video's description in link_description", () => {
    const video: AdCreative = {
      id: "1", name: "v",
      object_story_spec: { page_id: "6001", video_data: { video_id: "8", image_hash: "t", message: "M", title: "T" } },
    };
    const plan = planContentEdit(video, { descriptions: { set: ["Nueva desc"] } }, true);
    expect(parse(plan.body?.object_story_spec).video_data).toEqual({
      video_id: "8", image_hash: "t", message: "M", title: "T", link_description: "Nueva desc",
    });
  });
});

describe("planContentEdit — refusals", () => {
  it("throws when removing a text the ad does not have", () => {
    expect(() => planContentEdit(multiText(), { primary_texts: { remove: ["Nope"] } }, true))
      .toThrow(/Cannot remove primary text "Nope"/);
  });

  it("throws on more than five options, repeats or blanks", () => {
    expect(() => planContentEdit(multiText(), { primary_texts: { add: ["3", "4", "5", "6"] } }, true)).toThrow(/limit is 5/);
    expect(() => planContentEdit(multiText(), { primary_texts: { add: ["Uno"] } }, true)).toThrow(/repeat/);
    expect(() => planContentEdit(multiText(), { primary_texts: { add: ["  "] } }, true)).toThrow(/blank/);
  });

  it("points url_tags-only changes to ads_update_ad_url_tags", () => {
    expect(planContentEdit(multiText(), { url_tags: "utm_source=other" }, true).reason).toMatch(/ads_update_ad_url_tags/);
  });

  it("only edits a promoted post's primary texts", () => {
    const post: AdCreative = { id: "1", name: "p", effective_object_story_id: "6001_9", body: "Post text" };
    expect(planContentEdit(post, { headlines: { set: ["H"] } }, true).reason).toMatch(/promotes an existing post/);
    expect(planContentEdit(post, { primary_texts: { add: ["Otro"] } }, false).route).toBe("same_post");
  });

  it("refuses to switch an image ad to video", () => {
    expect(planContentEdit(singleImage(), { video_id: "800" }, true).reason).toMatch(/image ad to video/);
  });
});
