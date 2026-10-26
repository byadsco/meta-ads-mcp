import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerPreviewTools } from "../../src/tools/previews.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse, fetchCallSummary } from "../setup.js";

const PREVIEW = { data: [{ body: '<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=abc&amp;t=1"></iframe>' }] };

function generatePreview() {
  const server = createMockMcpServer();
  registerPreviewTools(server as never);
  const tool = server._registeredTools.find((t) => t.name === "ads_generate_preview");
  if (!tool) throw new Error("ads_generate_preview not registered");
  return tool.handler;
}

function sentCreative(): Record<string, unknown> {
  const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
  return JSON.parse(url.searchParams.get("creative") ?? "{}");
}

describe("ads_generate_preview", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds several text options from the simple fields, exactly as ads_create_ad_creative would", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse(PREVIEW)));
    const result = await generatePreview()({
      account_id: "act_123",
      ad_format: "MOBILE_FEED_STANDARD",
      page_id: "6001",
      image_hash: "abc123hash",
      link_url: "https://example.com",
      primary_texts: ["One", "Two"],
      headlines: ["Head"],
      call_to_action_type: "PLAY_GAME",
    }) as { content: Array<{ text: string }> };

    expect(fetchCallSummary()).toEqual(["GET /act_123/generatepreviews"]);
    expect(sentCreative()).toEqual({
      object_story_spec: {
        page_id: "6001",
        link_data: {
          image_hash: "abc123hash",
          link: "https://example.com",
          call_to_action: { type: "PLAY_GAME", value: { link: "https://example.com" } },
        },
      },
      asset_feed_spec: {
        bodies: [{ text: "One" }, { text: "Two" }],
        titles: [{ text: "Head" }],
        optimization_type: "DEGREES_OF_FREEDOM",
      },
    });
    expect(result.content[0].text).toContain("Preview URL: https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=1");
    expect(result.content[0].text).toContain("shows one combination");
  });

  it("sends a raw video description as link_description, the field Meta reads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse(PREVIEW)));
    await generatePreview()({
      account_id: "act_123",
      ad_format: "MOBILE_FEED_STANDARD",
      creative: {
        object_story_spec: {
          page_id: "6001",
          video_data: { video_id: "800123", image_hash: "thumb", description: "Below the headline" },
        },
      },
    });

    expect((sentCreative().object_story_spec as { video_data: unknown }).video_data).toEqual({
      video_id: "800123",
      image_hash: "thumb",
      link_description: "Below the headline",
    });
  });

  it("passes a raw asset_feed_spec through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse(PREVIEW)));
    const feed = { bodies: [{ text: "A" }, { text: "B" }], optimization_type: "DEGREES_OF_FREEDOM" };
    await generatePreview()({
      account_id: "act_123",
      ad_format: "MOBILE_FEED_STANDARD",
      creative: { object_story_spec: { page_id: "6001", link_data: { image_hash: "h" } }, asset_feed_spec: feed },
    });

    expect(sentCreative().asset_feed_spec).toEqual(feed);
  });

  it("refuses both or neither input styles before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const handler = generatePreview();

    await expect(handler({
      account_id: "act_123",
      ad_format: "MOBILE_FEED_STANDARD",
      page_id: "6001",
      creative: { object_story_spec: { page_id: "6001" } },
    })).rejects.toThrow(/not both/);
    await expect(handler({ account_id: "act_123", ad_format: "MOBILE_FEED_STANDARD" }))
      .rejects.toThrow(/page_id with the simple creative fields/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
