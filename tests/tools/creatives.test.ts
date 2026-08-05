import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import {
  CREATIVE_DEFAULT_FIELDS,
  SYNTHETIC_CREATIVE_FIELDS,
} from "../../src/meta/types/creative.js";
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

  it("never requests a synthetic field from Meta — the Graph API rejects them with #100", () => {
    for (const synthetic of SYNTHETIC_CREATIVE_FIELDS) {
      expect(CREATIVE_DEFAULT_FIELDS).not.toContain(synthetic);
    }
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
        "id,name,title,body,image_hash,image_url,thumbnail_url,object_story_spec,asset_feed_spec,call_to_action_type,link_url,effective_object_story_id,status,url_tags",
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

    it("accepts effective_link_url in fields by requesting its sources instead", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "40777",
        name: "Virtual Field Creative",
        link_url: "https://byads.co/landing",
      })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        creative_id: "40777",
        fields: ["name", "effective_link_url"],
      }) as { content: Array<{ type: string; text: string }> };

      const fieldsParam = new URL(vi.mocked(fetch).mock.calls[0][0] as string)
        .searchParams.get("fields");
      expect(fieldsParam).toBe("name,link_url,object_story_spec,asset_feed_spec");
      expect(fieldsParam).not.toContain("effective_link_url");
      expect(result.content[1].text).toContain("\"effective_link_url\": \"https://byads.co/landing\"");
    });

    it("derives effective_link_url when it is the only requested field", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "40778",
        name: "Link Data Creative",
        object_story_spec: {
          page_id: "6001",
          link_data: { link: "https://byads.co/promo" },
        },
      })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        creative_id: "40778",
        fields: ["effective_link_url"],
      }) as { content: Array<{ type: string; text: string }> };

      const fieldsParam = new URL(vi.mocked(fetch).mock.calls[0][0] as string)
        .searchParams.get("fields");
      expect(fieldsParam).toBe("link_url,object_story_spec,asset_feed_spec");
      expect(result.content[0].text).toContain("Link URL: https://byads.co/promo");
    });

    it("strips a synthetic field hidden inside a comma-joined entry", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "40780" })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "40780",
        fields: ["id,name,effective_link_url"],
      });

      const fieldsParam = new URL(vi.mocked(fetch).mock.calls[0][0] as string)
        .searchParams.get("fields");
      expect(fieldsParam).toBe("id,name,link_url,object_story_spec,asset_feed_spec");
      expect(fieldsParam).not.toContain("effective_link_url");
    });

    it("strips a synthetic field from an entry that also carries a nested selector", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "40782" })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "40782",
        fields: ["id,effective_link_url,object_story_spec{link_data,name}"],
      });

      const fieldsParam = new URL(vi.mocked(fetch).mock.calls[0][0] as string)
        .searchParams.get("fields");
      expect(fieldsParam).not.toContain("effective_link_url");
      expect(fieldsParam).toContain("object_story_spec{link_data,name}");
      expect(fieldsParam).toContain("link_url");
    });

    it("keeps nested field selectors intact", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "40781" })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "40781",
        fields: ["object_story_spec{link_data,video_data}", "name"],
      });

      expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("fields"))
        .toBe("object_story_spec{link_data,video_data},name");
    });

    it("does not duplicate source fields already requested by the caller", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "40779" })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "40779",
        fields: ["link_url", "effective_link_url"],
      });

      expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("fields"))
        .toBe("link_url,object_story_spec,asset_feed_spec");
    });
  });

  describe("ads_get_ad_creatives handler", () => {
    it("requests url_tags by default and reports them per creative", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{ id: "4001", name: "C1", url_tags: "utm_source=meta" }],
      })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        ad_id: undefined,
        account_id: "act_123",
        limit: 25,
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("fields"))
        .toContain("url_tags");
      expect(result.content[0].text).toContain("utm_source=meta");
    });

    it("strips effective_link_url from caller fields and derives it per creative", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        data: [{
          id: "4002",
          name: "C2",
          object_story_spec: {
            page_id: "6001",
            video_data: {
              video_id: "8001",
              call_to_action: { type: "SHOP_NOW", value: { link: "https://byads.co/shop" } },
            },
          },
        }],
      })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        ad_id: undefined,
        account_id: "act_123",
        limit: 25,
        fields: ["id", "effective_link_url"],
      }) as { content: Array<{ type: string; text: string }> };

      expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("fields"))
        .toBe("id,link_url,object_story_spec,asset_feed_spec");
      expect(result.content[1].text).toContain("\"effective_link_url\": \"https://byads.co/shop\"");
    });
  });

  describe("ads_update_ad_creative handler", () => {
    it("refuses an empty update instead of reporting a false success", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn());

      const handler = server._registeredTools[3].handler;
      await expect(handler({ creative_id: "4001", name: undefined }))
        .rejects.toThrow(/immutable/i);
      await expect(handler({ creative_id: "4001", name: undefined }))
        .rejects.toThrow(/ads_update_ad_url_tags/);

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("updates the creative name", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        creative_id: "4001",
        name: "Renamed Creative",
      }) as { content: Array<{ type: string; text: string }> };

      const call = vi.mocked(fetch).mock.calls[0];
      expect(new URL(call[0] as string).pathname).toMatch(/\/4001$/);
      expect(call[1]?.method).toBe("POST");
      expect(new URLSearchParams(call[1]?.body as string).get("name")).toBe("Renamed Creative");
      expect(result.content[0].text).toContain("updated successfully");
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
