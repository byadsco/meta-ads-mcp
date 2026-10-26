import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    expect(Object.keys(body).sort()).toEqual(["name", "object_story_spec", "url_tags"]);
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
    expect(Object.keys(body).sort()).toEqual(["instagram_user_id", "name", "object_story_id"]);
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
      "call_to_action", "instagram_user_id", "name", "object_id", "source_instagram_media_id",
    ]);
    expect(body.object_id).toBe("6001");
    expect(body.source_instagram_media_id).toBe("17900000000000001");
    expect(JSON.parse(body.call_to_action)).toEqual({ type: "SHOP_NOW", value: { link: "https://example.com/ig" } });
  });

  it("forwards url_tags exactly as given", async () => {
    stubCreateAndReadBack();
    await createHandler()({
      ...EMPTY_INPUT,
      page_id: "6001",
      image_hash: "abc123hash",
      link_url: "https://example.com",
      url_tags: "?utm_source=meta&utm_medium=paid",
    });

    expect(sentBody().url_tags).toBe("?utm_source=meta&utm_medium=paid");
  });

  it("requires page_id when building from scratch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createHandler()({ ...EMPTY_INPUT, image_hash: "abc123hash" }))
      .rejects.toThrow(/page_id is required/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
