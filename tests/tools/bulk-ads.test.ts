import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBulkAdTools } from "../../src/tools/bulk-ads.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

// Keep every real guard rule (protocol, private-IP literals) and stub only DNS,
// so test hostnames need no network yet SSRF rejections stay genuine.
vi.mock("../../src/utils/url-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/url-guard.js")>();
  return {
    ...actual,
    assertSafePublicUrl: (raw: string) =>
      actual.assertSafePublicUrl(raw, {
        resolve: async () => [{ address: "93.184.216.34" }],
      }),
  };
});

const BASE_ARGS = {
  account_id: "act_123",
  ad_set_id: "456",
  page_id: "789",
  status: "PAUSED" as const,
  max_wait_seconds: 0,
};

function handlerFor(name: string) {
  const server = createMockMcpServer();
  registerBulkAdTools(server as never);
  const tool = server._registeredTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

describe("registerBulkAdTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 1 tool", () => {
    const server = createMockMcpServer();
    registerBulkAdTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  it("registers the tool with the expected name and write annotation", () => {
    const tool = handlerFor("ads_bulk_create_video_ads");
    expect(tool.name).toBe("ads_bulk_create_video_ads");
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
  });

  describe("ads_bulk_create_video_ads handler", () => {
    it("uploads, waits, builds the creative and creates the ad for each video", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/a.jpg" }, { uri: "https://cdn.example/b.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_1" }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/video.mp4", ad_name: "Aprovado 13" }],
        message: "texto",
        headline: "titular",
        link_url: "https://example.com",
        call_to_action_type: "SIGN_UP",
      });

      const urls = fetchMock.mock.calls.map(urlOf);
      expect(urls[0]).toContain("/act_123/advideos");
      expect(urls[1]).toContain("/vid_1");
      expect(urls[2]).toContain("/act_123/adcreatives");
      expect(urls[3]).toContain("/act_123/ads");

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0]).toMatchObject({
        video_id: "vid_1",
        creative_id: "cre_1",
        ad_id: "ad_1",
        thumbnail_url: "https://cdn.example/b.jpg",
      });
      expect(res.content[0].text).toContain("Created 1 of 1");
    });

    it("prefers the is_preferred thumbnail and falls back to the first one", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/first.jpg" }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_1" }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/video.mp4" }],
      });

      expect(JSON.parse(res.content[1].text)[0].thumbnail_url).toBe("https://cdn.example/first.jpg");
    });

    it("applies per-video copy over the shared defaults", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_1" }));
      vi.stubGlobal("fetch", fetchMock);

      await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/v.mp4", message: "propio", headline: "propio-h" }],
        message: "compartido",
        headline: "compartido-h",
        description: "compartido-d",
      });

      const creativeBody = String(fetchMock.mock.calls[2][1]?.body ?? "");
      const spec = JSON.parse(decodeURIComponent(creativeBody).match(/object_story_spec=([^&]*)/)![1]);
      expect(spec.video_data.message).toBe("propio");
      expect(spec.video_data.title).toBe("propio-h");
      expect(spec.video_data.link_description).toBe("compartido-d");
    });

    it("keeps successful items when one video fails", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({ error: { message: "Invalid file", code: 100 } }, { status: 400 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "https://cdn.example/ok.mp4", ad_name: "bueno" },
          { file_url: "https://cdn.example/bad.mp4", ad_name: "malo" },
        ],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].ad_id).toBe("ad_1");
      expect(payload[1].ad_id).toBeUndefined();
      expect(payload[1].error).toBeTruthy();
      expect(res.content[0].text).toContain("Created 1 of 2");
      expect(res.content[0].text).toContain("malo");
    });

    it("reports a processing timeout without creating the ad", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ status: { video_status: "processing" } }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/slow.mp4" }],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("processing");
      expect(payload[0].ad_id).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("surfaces a Meta processing error immediately", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ status: { video_status: "error" } }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/broken.mp4" }],
      });

      expect(JSON.parse(res.content[1].text)[0].failed_stage).toBe("processing");
    });

    it("fails the item when Meta returns no thumbnail", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ status: { video_status: "ready" }, thumbnails: { data: [] } }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/v.mp4" }],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("creative");
      expect(payload[0].error).toContain("thumbnail");
    });

    it("refuses a private file_url without calling Meta", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://169.254.169.254/latest/meta-data/" }],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("upload");
      expect(payload[0].error).toMatch(/Refusing to forward/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a malformed ad_set_id before any network call", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        tool.handler({
          ...BASE_ARGS,
          ad_set_id: "456/../me",
          videos: [{ file_url: "https://cdn.example/v.mp4" }],
        }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("creates ads PAUSED by default", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_1" }));
      vi.stubGlobal("fetch", fetchMock);

      await tool.handler({
        account_id: "act_123",
        ad_set_id: "456",
        page_id: "789",
        max_wait_seconds: 0,
        status: "PAUSED",
        videos: [{ file_url: "https://cdn.example/v.mp4" }],
      });

      expect(String(fetchMock.mock.calls[3][1]?.body ?? "")).toContain("status=PAUSED");
    });
  });
});
