import { describe, it, expect } from "vitest";
import { effectiveLinkUrl } from "../../src/meta/effective-link.js";

describe("effectiveLinkUrl", () => {
  it("follows Meta's precedence: override, video button, link, link button, first feed link", () => {
    const spec = {
      video_data: { call_to_action: { value: { link: "https://v.example/" } } },
      link_data: { link: "https://l.example/", call_to_action: { value: { link: "https://lb.example/" } } },
    };
    expect(effectiveLinkUrl({ link_url: "https://o.example/", object_story_spec: spec })).toBe("https://o.example/");
    expect(effectiveLinkUrl({ object_story_spec: spec })).toBe("https://v.example/");
    expect(effectiveLinkUrl({ object_story_spec: { link_data: spec.link_data } })).toBe("https://l.example/");
    expect(effectiveLinkUrl({ object_story_spec: { link_data: { call_to_action: spec.link_data.call_to_action } } }))
      .toBe("https://lb.example/");
  });

  it("reads only the first link of an asset feed", () => {
    expect(effectiveLinkUrl({ asset_feed_spec: { link_urls: [{ website_url: "https://f1.example/" }, { website_url: "https://f2.example/" }] } }))
      .toBe("https://f1.example/");
    expect(effectiveLinkUrl({ asset_feed_spec: { link_urls: [{ website_url: "" }, { website_url: "https://f2.example/" }] } }))
      .toBeUndefined();
    expect(effectiveLinkUrl({})).toBeUndefined();
  });
});
