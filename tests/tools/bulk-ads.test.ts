import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBulkAdTools } from "../../src/tools/bulk-ads.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

// Keep every real guard rule (protocol, private-IP checks) and stub only DNS,
// so test hostnames need no network yet SSRF rejections stay genuine. Tests
// point `address` at a private range to exercise the resolve-time rejection.
const guardState = vi.hoisted(() => ({ address: "93.184.216.34" }));

vi.mock("../../src/utils/url-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/url-guard.js")>();
  return {
    ...actual,
    assertSafePublicUrl: (raw: string) =>
      actual.assertSafePublicUrl(raw, {
        resolve: async () => [{ address: guardState.address }],
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
    guardState.address = "93.184.216.34";
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

    it("defaults the ad status to PAUSED in the schema", () => {
      const tool = handlerFor("ads_bulk_create_video_ads");
      const schema = tool.schema as { status: { parse: (value: unknown) => unknown } };
      expect(schema.status.parse(undefined)).toBe("PAUSED");
    });

    it("sends the chosen status when creating the ad", async () => {
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
        videos: [{ file_url: "https://cdn.example/v.mp4" }],
      });

      expect(String(fetchMock.mock.calls[3][1]?.body ?? "")).toContain("status=PAUSED");
    });

    it("rejects a hostname that resolves to a private address", async () => {
      guardState.address = "10.0.0.5";

      const tool = handlerFor("ads_bulk_create_video_ads");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://internal.example/v.mp4" }],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("upload");
      expect(payload[0].error).toMatch(/private IP/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("stops the batch on an account-wide error and keeps the ads already created", async () => {
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
        .mockResolvedValue(
          mockFetchResponse(
            { error: { message: "Error validating access token: Session has expired", code: 190 } },
            { status: 401 },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "https://cdn.example/a.mp4", ad_name: "uno" },
          { file_url: "https://cdn.example/b.mp4", ad_name: "dos" },
          { file_url: "https://cdn.example/c.mp4", ad_name: "tres" },
        ],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].ad_id).toBe("ad_1");
      expect(payload[1].error).toBeTruthy();
      expect(payload[2].skipped).toBe(true);
      expect(res.content[0].text).toContain("affects every video");
    }, 30_000);

    it("throws the account-wide error when nothing was created", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse(
          { error: { message: "Error validating access token: Session has expired", code: 190 } },
          { status: 401 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        tool.handler({
          ...BASE_ARGS,
          videos: [{ file_url: "https://cdn.example/a.mp4" }, { file_url: "https://cdn.example/b.mp4" }],
        }),
      ).rejects.toThrow(/token|expired/i);
    });

    it("stops after the same failure repeats, instead of burning the whole batch", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      // A shared bad page_id/ad_set_id looks item-scoped (InvalidParams) but
      // condemns every video: identical failures must halt the run.
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
        .mockResolvedValue(
          mockFetchResponse({ error: { message: "Invalid parameter", code: 100 } }, { status: 400 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "https://cdn.example/a.mp4", ad_name: "uno" },
          { file_url: "https://cdn.example/b.mp4", ad_name: "dos" },
          { file_url: "https://cdn.example/c.mp4", ad_name: "tres" },
          { file_url: "https://cdn.example/d.mp4", ad_name: "cuatro" },
        ],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].ad_id).toBe("ad_1");
      expect(payload[1].error).toBeTruthy();
      expect(payload[2].error).toBeTruthy();
      expect(payload[3].skipped).toBe(true);
      // 4 calls for the first video, then one doomed upload each for videos 2-3.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    }, 30_000);

    it("does not let two locally-rejected URLs stop a healthy batch", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_3" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_3" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_3" }));
      vi.stubGlobal("fetch", fetchMock);

      // Both http:// URLs yield the identical guard message; that must not be
      // mistaken for a shared bad input and skip the valid third video.
      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "http://a.example/v.mp4" },
          { file_url: "http://b.example/v.mp4" },
          { file_url: "https://cdn.example/good.mp4" },
        ],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("upload");
      expect(payload[1].failed_stage).toBe("upload");
      expect(payload[2].skipped).toBeUndefined();
      expect(payload[2].ad_id).toBe("ad_3");
    }, 30_000);

    it("reports partial artifacts instead of throwing them away", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      // Creatives get built, then every ad creation fails identically: the run
      // stops but the video and creative IDs must survive in the report.
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
        .mockResolvedValueOnce(
          mockFetchResponse({ error: { message: "Invalid adset", code: 100 } }, { status: 400 }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_2" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_2" }))
        .mockResolvedValue(
          mockFetchResponse({ error: { message: "Invalid adset", code: 100 } }, { status: 400 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "https://cdn.example/a.mp4" },
          { file_url: "https://cdn.example/b.mp4" },
          { file_url: "https://cdn.example/c.mp4" },
        ],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].creative_id).toBe("cre_1");
      expect(payload[1].creative_id).toBe("cre_2");
      expect(payload[0].ad_id).toBeUndefined();
      expect(payload[2].skipped).toBe(true);
    }, 60_000);

    it("throws when the same failure repeats and nothing was created", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: "Invalid parameter", code: 100 } }, { status: 400 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        tool.handler({
          ...BASE_ARGS,
          videos: [
            { file_url: "https://cdn.example/a.mp4" },
            { file_url: "https://cdn.example/b.mp4" },
            { file_url: "https://cdn.example/c.mp4" },
          ],
        }),
      ).rejects.toThrow(/Invalid parameter/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 30_000);

    it("keeps going when failures differ between videos", async () => {
      const tool = handlerFor("ads_bulk_create_video_ads");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_1" }))
        .mockResolvedValueOnce(mockFetchResponse({ status: { video_status: "ready" }, thumbnails: { data: [] } }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_2" }))
        .mockResolvedValueOnce(mockFetchResponse({ status: { video_status: "ready" }, thumbnails: { data: [] } }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "vid_3" }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            status: { video_status: "ready" },
            thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse({ id: "cre_3" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "ad_3" }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [
          { file_url: "https://cdn.example/a.mp4" },
          { file_url: "https://cdn.example/b.mp4" },
          { file_url: "https://cdn.example/c.mp4" },
        ],
      });

      // Each no-thumbnail message names its own video_id, so the signatures
      // differ and the third video still gets its ad.
      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("creative");
      expect(payload[1].failed_stage).toBe("creative");
      expect(payload[2].ad_id).toBe("ad_3");
    }, 30_000);

    it("labels a failure at the ad stage without losing the creative id", async () => {
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
        .mockResolvedValueOnce(
          mockFetchResponse({ error: { message: "Invalid adset", code: 100 } }, { status: 400 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const res = await tool.handler({
        ...BASE_ARGS,
        videos: [{ file_url: "https://cdn.example/v.mp4" }],
      });

      const payload = JSON.parse(res.content[1].text);
      expect(payload[0].failed_stage).toBe("ad");
      expect(payload[0].creative_id).toBe("cre_1");
      expect(payload[0].ad_id).toBeUndefined();
    });
  });
});
