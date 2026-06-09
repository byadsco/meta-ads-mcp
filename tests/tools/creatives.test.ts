import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import { CREATIVE_DEFAULT_FIELDS } from "../../src/meta/types/creative.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
} from "../setup.js";

describe("registerCreativeTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("never requests effective_link_url — not a real Meta AdCreative field (Graph API rejects it with #100)", () => {
    expect(CREATIVE_DEFAULT_FIELDS).not.toContain("effective_link_url");
  });

  it("registers exactly 9 tools", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(9);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);

    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_ad_creatives",
      "ads_get_creative_details",
      "ads_create_ad_creative",
      "ads_update_ad_creative",
      "ads_upload_ad_image",
      "ads_get_ad_images",
      "ads_get_ad_videos",
      "ads_get_video_details",
      "ads_upload_ad_video",
    ]);
  });

  describe("ads_get_creative_details handler", () => {
    it("uses default fields and returns a readable summary", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      const mockCreative = {
        id: "40123",
        name: "Spring Creative",
        status: "ACTIVE",
        call_to_action_type: "LEARN_MORE",
        link_url: "https://example.com",
        effective_object_story_id: "6001_9",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockCreative)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        creative_id: "40123",
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Creative: Spring Creative (40123)");
      expect(result.content[0].text).toContain("Status: ACTIVE");
      expect(result.content[0].text).toContain("CTA: LEARN_MORE");

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("/40123");
      expect(url.searchParams.get("fields")).toBe(
        "id,name,title,body,image_hash,image_url,thumbnail_url,object_story_spec,asset_feed_spec,call_to_action_type,link_url,effective_object_story_id,status",
      );
    });

    it("uses custom fields when provided", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "40999",
        name: "Custom Fields Creative",
      })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "40999",
        fields: ["id", "name"],
      });

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.searchParams.get("fields")).toBe("id,name");
    });

    it("falls back to the effective link from video_data CTA when link_url is missing", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "4099",
        name: "Video Creative",
        status: "ACTIVE",
        call_to_action_type: "APPLY_NOW",
        object_story_spec: {
          page_id: "6001",
          video_data: {
            video_id: "8001",
            call_to_action: {
              type: "APPLY_NOW",
              value: { link: "https://ugc.byads.co/chile" },
            },
          },
        },
      })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        creative_id: "4099",
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Link URL: https://ugc.byads.co/chile");
      expect(result.content[1].text).toContain("\"effective_link_url\": \"https://ugc.byads.co/chile\"");
    });
  });

  describe("ads_create_ad_creative handler", () => {
    it("fails locally when a scratch video creative is missing thumbnail data", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn());

      const handler = server._registeredTools[2].handler;
      await expect(handler({
        account_id: "act_123",
        name: "Video sin thumb",
        page_id: "6001",
        video_id: "800123",
        image_hash: undefined,
        image_url: undefined,
        link_url: "https://example.com",
        message: "Texto",
        headline: "Headline",
        description: "Description",
        call_to_action_type: "APPLY_NOW",
        instagram_actor_id: undefined,
        object_story_id: undefined,
        source_instagram_media_id: undefined,
        url_tags: undefined,
      })).rejects.toThrow(/require image_hash or image_url as a thumbnail/i);

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});
