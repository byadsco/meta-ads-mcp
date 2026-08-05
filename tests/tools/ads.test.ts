import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAdTools } from "../../src/tools/ads.js";
import { metaApiClient } from "../../src/meta/client.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
} from "../setup.js";

type ToolResult = { content: Array<{ type: string; text: string }> };

const UPDATE_AD = 3;
const UPDATE_URL_TAGS = 4;

function bodyOf(callIndex: number): URLSearchParams {
  const call = vi.mocked(fetch).mock.calls[callIndex];
  return new URLSearchParams(call[1]?.body as string);
}

function pathOf(callIndex: number): string {
  return new URL(vi.mocked(fetch).mock.calls[callIndex][0] as string).pathname;
}

function methods(): Array<string | undefined> {
  return vi.mocked(fetch).mock.calls.map((c) => c[1]?.method);
}

function adResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "3001",
    account_id: "123",
    creative: { id: "4001" },
    ...overrides,
  };
}

function specCreative(overrides: Record<string, unknown> = {}) {
  return {
    id: "4001",
    name: "Creative A",
    object_story_spec: {
      page_id: "6001",
      link_data: { link: "https://byads.co", image_hash: "h1" },
    },
    ...overrides,
  };
}

describe("registerAdTools", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    metaApiClient.resetForTests();
    vi.restoreAllMocks();
  });

  it("registers exactly 6 tools", () => {
    const server = createMockMcpServer();
    registerAdTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerAdTools(server as never);

    expect(server._registeredTools.map((t) => t.name)).toEqual([
      "ads_get_ads",
      "ads_get_ad_details",
      "ads_create_ad",
      "ads_update_ad",
      "ads_update_ad_url_tags",
      "ads_delete_ad",
    ]);
  });

  describe("ads_update_ad handler", () => {
    it("updates name and status with a single request", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_AD].handler;
      const result = await handler({
        ad_id: "3001",
        name: "Renamed",
        status: "PAUSED",
        creative_id: undefined,
      }) as ToolResult;

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      expect(pathOf(0)).toMatch(/\/3001$/);
      expect(methods()[0]).toBe("POST");
      expect(bodyOf(0).get("name")).toBe("Renamed");
      expect(bodyOf(0).get("status")).toBe("PAUSED");
      expect(bodyOf(0).has("creative")).toBe(false);
      expect(result.content[0].text).toContain("updated successfully");
    });

    it("refuses an empty update instead of reporting a false success", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn());

      const handler = server._registeredTools[UPDATE_AD].handler;
      await expect(handler({
        ad_id: "3001",
        name: undefined,
        status: undefined,
        creative_id: undefined,
      })).rejects.toThrow(/at least one/i);

      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  describe("ads_update_ad_url_tags handler", () => {
    it("reuses the existing post when the creative has one", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({
          effective_object_story_id: "6001_777",
          url_tags: "utm_source=old",
        })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta&utm_medium=paid",
        dry_run: false,
      }) as ToolResult;

      const creativeFields = new URL(vi.mocked(fetch).mock.calls[1][0] as string)
        .searchParams.get("fields");
      expect(creativeFields).toBe(
        "id,name,object_story_spec,asset_feed_spec,effective_object_story_id,url_tags,instagram_user_id,source_instagram_media_id,effective_instagram_media_id,link_url,degrees_of_freedom_spec,call_to_action_type,adlabels",
      );
      expect(creativeFields).not.toContain("effective_link_url");

      expect(pathOf(2)).toContain("/act_123/adcreatives");
      expect(bodyOf(2).get("object_story_id")).toBe("6001_777");
      expect(bodyOf(2).get("url_tags")).toBe("utm_source=meta&utm_medium=paid");
      expect(bodyOf(2).get("name")).toBe("Creative A");
      expect(bodyOf(2).has("object_story_spec")).toBe(false);

      expect(pathOf(3)).toMatch(/\/3001$/);
      expect(JSON.parse(bodyOf(3).get("creative") ?? "{}")).toEqual({ creative_id: "4100" });

      expect(result.content[0].text).toContain("4001");
      expect(result.content[0].text).toContain("4100");
      expect(result.content[0].text).toMatch(/review/i);
    });

    it("clones object_story_spec when there is no reusable post", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).has("object_story_id")).toBe(false);
      expect(JSON.parse(bodyOf(2).get("object_story_spec") ?? "{}")).toEqual({
        page_id: "6001",
        link_data: { link: "https://byads.co", image_hash: "h1" },
      });
      expect(bodyOf(2).get("url_tags")).toBe("utm_source=meta");
    });

    it("carries the Instagram identity from the creative", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({
          effective_object_story_id: "6001_777",
          instagram_user_id: "9001",
        })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("instagram_user_id")).toBe("9001");
    });

    it("carries a spec-embedded Instagram identity", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "Creative A",
          effective_object_story_id: "6001_777",
          object_story_spec: { page_id: "6001", instagram_user_id: "9002", link_data: { link: "https://byads.co" } },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("instagram_user_id")).toBe("9002");
    });

    it("reuses the Instagram media when the creative has no post or spec", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "IG Post Creative",
          source_instagram_media_id: "7001",
          effective_instagram_media_id: "7002",
          instagram_user_id: "9003",
          url_tags: "utm_source=old",
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("source_instagram_media_id")).toBe("7001");
      expect(bodyOf(2).get("instagram_user_id")).toBe("9003");
      expect(bodyOf(2).get("url_tags")).toBe("utm_source=meta");
      expect(bodyOf(2).has("object_story_id")).toBe(false);
      expect(bodyOf(2).has("object_story_spec")).toBe(false);
    });

    it("rebuilds the CTA of an Instagram creative, which stores it on the creative", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "IG Post Creative",
          source_instagram_media_id: "7001",
          call_to_action_type: "SHOP_NOW",
          link_url: "https://byads.co/shop",
          url_tags: "utm_source=old",
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(JSON.parse(bodyOf(2).get("call_to_action") ?? "{}")).toEqual({
        type: "SHOP_NOW",
        value: { link: "https://byads.co/shop" },
      });
    });

    it("carries ad labels to the replacement creative", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({
          adlabels: [{ id: "5001", name: "Q3" }, { name: "Brand" }],
        })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(JSON.parse(bodyOf(2).get("adlabels") ?? "[]")).toEqual([{ id: "5001" }, { name: "Brand" }]);
    });

    it("counts a repoint as updated when the ad is confirmed to have moved", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: { message: "(#100) lost response", type: "OAuthException", code: 100 } },
          { status: 400 },
        ))
        .mockResolvedValueOnce(mockFetchResponse({ id: "3001", creative: { id: "4100" } })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const report = JSON.parse(result.content[1].text) as {
        updated: Array<{ ad_id: string }>;
        failed: unknown[];
        warnings: string[];
      };
      expect(report.updated.map((u) => u.ad_id)).toEqual(["3001"]);
      expect(report.failed).toHaveLength(0);
      expect(report.warnings[0]).toContain("4100");
    });

    it("reports an unknown state when the ad cannot be read back", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: { message: "(#100) boom", type: "OAuthException", code: 100 } },
          { status: 400 },
        ))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: { message: "(#100) unreadable", type: "OAuthException", code: 100 } },
          { status: 400 },
        )));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const report = JSON.parse(result.content[1].text) as {
        failed: Array<{ ad_id: string; error: string; new_creative_id?: string }>;
      };
      expect(report.failed[0].ad_id).toBe("3001");
      expect(report.failed[0].error).toMatch(/state is unknown/i);
      expect(report.failed[0].new_creative_id).toBe("4100");
    });

    it("prefers the existing post over the Instagram media when both are present", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "IG Post Creative",
          effective_object_story_id: "6001_7777",
          source_instagram_media_id: "7001",
          instagram_user_id: "9003",
          url_tags: "utm_source=old",
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("object_story_id")).toBe("6001_7777");
      expect(bodyOf(2).has("source_instagram_media_id")).toBe(false);
      expect(bodyOf(2).get("instagram_user_id")).toBe("9003");
    });

    it("creates one creative for ads that share it", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3001" })))
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3002" })))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001", "3002"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const creativeCreations = vi.mocked(fetch).mock.calls.filter(
        (c) => (c[0] as string).includes("/adcreatives"),
      );
      expect(creativeCreations).toHaveLength(1);
      expect(JSON.parse(bodyOf(4).get("creative") ?? "{}")).toEqual({ creative_id: "4100" });
      expect(JSON.parse(bodyOf(5).get("creative") ?? "{}")).toEqual({ creative_id: "4100" });
      expect([pathOf(4), pathOf(5)].map((p) => p.split("/").pop()).sort()).toEqual(["3001", "3002"]);

      const report = JSON.parse(result.content[1].text) as { updated: Array<{ ad_id: string }> };
      expect(report.updated.map((u) => u.ad_id).sort()).toEqual(["3001", "3002"]);
    });

    it("reads each ad once when an id is repeated", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001", "3001"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
      const report = JSON.parse(result.content[1].text) as { updated: unknown[] };
      expect(report.updated).toHaveLength(1);
    });

    it("carries the destination override and Advantage+ enhancement settings", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      const dof = { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_IN" } } };
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({
          link_url: "https://byads.co/landing",
          degrees_of_freedom_spec: dof,
        })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("link_url")).toBe("https://byads.co/landing");
      expect(JSON.parse(bodyOf(2).get("degrees_of_freedom_spec") ?? "{}")).toEqual(dof);
    });

    it("skips ads whose url_tags already match", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({ url_tags: "utm_source=meta" }))));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      expect(methods()).toEqual(["GET", "GET"]);
      const report = JSON.parse(result.content[1].text) as { skipped: Array<{ reason: string }> };
      expect(report.skipped[0].reason).toMatch(/already/i);
    });

    it("treats a leading question mark as equivalent", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({ url_tags: "utm_source=meta" }))));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "?utm_source=meta", dry_run: false });

      expect(methods()).toEqual(["GET", "GET"]);
    });

    it("strips a leading question mark from the value it writes", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({ url_tags: "utm_source=old" })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "?utm_source=meta", dry_run: false });

      expect(bodyOf(2).get("url_tags")).toBe("utm_source=meta");
    });

    it("removes url_tags when passed an empty string", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({ url_tags: "utm_source=old" })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "", dry_run: false });

      expect(bodyOf(2).has("url_tags")).toBe(false);
      expect(JSON.parse(bodyOf(3).get("creative") ?? "{}")).toEqual({ creative_id: "4100" });
    });

    it("skips removal when the creative has no url_tags", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative())));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      await handler({ ad_ids: ["3001"], url_tags: "", dry_run: false });

      expect(methods()).toEqual(["GET", "GET"]);
    });

    it("skips dynamic creatives and keeps processing the rest of the batch", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3001", creative: { id: "4001" } })))
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3002", creative: { id: "4002" } })))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "Dynamic",
          asset_feed_spec: { link_urls: [{ website_url: "https://byads.co" }] },
        }))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({ id: "4002" })))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001", "3002"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const report = JSON.parse(result.content[1].text) as {
        updated: Array<{ ad_id: string }>;
        skipped: Array<{ ad_id: string; reason: string }>;
      };
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0].ad_id).toBe("3001");
      expect(report.skipped[0].reason).toMatch(/asset_feed_spec|dynamic/i);
      expect(report.updated.map((u) => u.ad_id)).toEqual(["3002"]);
    });

    it("reports ads without a creative as failed without aborting", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "3001", account_id: "123" }))
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3002" })))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001", "3002"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const report = JSON.parse(result.content[1].text) as {
        updated: Array<{ ad_id: string }>;
        failed: Array<{ ad_id: string; error: string }>;
      };
      expect(report.failed[0].ad_id).toBe("3001");
      expect(report.failed[0].error).toMatch(/creative/i);
      expect(report.updated.map((u) => u.ad_id)).toEqual(["3002"]);
    });

    it("writes nothing in dry_run mode", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(specCreative({
          effective_object_story_id: "6001_777",
          url_tags: "utm_source=old",
        }))));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta",
        dry_run: true,
      }) as ToolResult;

      expect(methods()).toEqual(["GET", "GET"]);
      const report = JSON.parse(result.content[1].text) as {
        dry_run: boolean;
        planned: Array<{ ad_id: string; strategy: string; old_creative_id: string }>;
      };
      expect(report.dry_run).toBe(true);
      expect(report.planned[0]).toMatchObject({ ad_id: "3001", old_creative_id: "4001" });
      expect(report.planned[0].strategy).toMatch(/post/i);
    });

    it("reports a failed repoint with the orphaned creative id", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3001" })))
        .mockResolvedValueOnce(mockFetchResponse(adResponse({ id: "3002" })))
        .mockResolvedValueOnce(mockFetchResponse(specCreative()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true }))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: { message: "(#100) invalid ad", type: "OAuthException", code: 100 } },
          { status: 400 },
        ))
        .mockResolvedValueOnce(mockFetchResponse({ id: "3002", creative: { id: "4001" } })));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001", "3002"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      const report = JSON.parse(result.content[1].text) as {
        updated: Array<{ ad_id: string }>;
        failed: Array<{ ad_id: string; error: string; new_creative_id?: string }>;
      };
      expect(report.updated.map((u) => u.ad_id)).toEqual(["3001"]);
      expect(report.failed[0].ad_id).toBe("3002");
      expect(report.failed[0].new_creative_id).toBe("4100");
    });

    it("fails the whole group when the creative cannot be read", async () => {
      const server = createMockMcpServer();
      registerAdTools(server as never);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(adResponse()))
        .mockResolvedValueOnce(mockFetchResponse(
          { error: { message: "(#100) missing", type: "OAuthException", code: 100 } },
          { status: 400 },
        )));

      const handler = server._registeredTools[UPDATE_URL_TAGS].handler;
      const result = await handler({
        ad_ids: ["3001"],
        url_tags: "utm_source=meta",
        dry_run: false,
      }) as ToolResult;

      expect(methods()).toEqual(["GET", "GET"]);
      const report = JSON.parse(result.content[1].text) as {
        failed: Array<{ ad_id: string; error: string }>;
      };
      expect(report.failed[0].ad_id).toBe("3001");
    });
  });
});
