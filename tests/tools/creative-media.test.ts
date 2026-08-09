import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerCreativeMediaTools, collectCreativeMedia, pickVideoThumbnailUrl } from "../../src/tools/creative-media.js";
import { downloadSafePublicImage } from "../../src/utils/safe-download.js";
import { createMockMcpServer, mockFetchResponse, setupTestToken, cleanupTestToken } from "../setup.js";

type ToolResult = { content: Array<Record<string, unknown>> };

function fakeDownload() {
  return vi.fn(async (url: string) => ({
    buffer: Buffer.from("img"),
    contentType: "image/jpeg",
    extension: ".jpg" as const,
    finalUrl: new URL(url),
  }));
}

function registerWithDownload(download = fakeDownload()) {
  const server = createMockMcpServer();
  registerCreativeMediaTools(server as never, { download: download as never });
  return { server, download, handler: server._registeredTools[0].handler };
}

function fetchCalls(): string[] {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function resultJson(result: ToolResult): Record<string, unknown> {
  const last = result.content[result.content.length - 1];
  return JSON.parse(last.text as string) as Record<string, unknown>;
}

describe("registerCreativeMediaTools", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers exactly one read-only tool with a meaningful description", () => {
    const { server } = registerWithDownload();
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = server._registeredTools[0];
    expect(tool.name).toBe("ads_get_creative_media");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description.length).toBeGreaterThan(10);
  });

  it("requires exactly one of ad_id or creative_id", async () => {
    const { handler } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn());

    await expect(handler({})).rejects.toThrow(/ad_id or creative_id is required/);
    await expect(handler({ ad_id: "1", creative_id: "2" })).rejects.toThrow(/not both/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns a simple image creative as an inline image block", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Test creative",
      image_url: "https://cdn.example.com/full.jpg",
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(fetchCalls()).toHaveLength(1);
    expect(fetchCalls()[0]).toContain("/40123");
    expect(fetchCalls()[0]).toContain("thumbnail_width=1080");
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/full.jpg", expect.objectContaining({ maxBytes: expect.any(Number) }));

    expect(result.content).toHaveLength(3);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1]).toEqual({
      type: "image",
      data: Buffer.from("img").toString("base64"),
      mimeType: "image/jpeg",
    });

    const json = resultJson(result);
    const images = json.images as Array<Record<string, unknown>>;
    expect(images[0]).toMatchObject({ role: "primary", block_index: 0, downloaded: true, bytes: 3 });
  });

  it("resolves the creative and account from an ad_id", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "120001", account_id: "111", creative: { id: "40123" } }))
      .mockResolvedValueOnce(mockFetchResponse({ id: "40123", name: "C", image_hash: "h1" }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [{ hash: "h1", url: "https://cdn.example.com/h1.jpg", width: 1080, height: 1080 }] })));

    const result = await handler({ ad_id: "120001" }) as ToolResult;

    const calls = fetchCalls();
    expect(calls[0]).toContain("/120001");
    expect(calls[0]).toContain(encodeURIComponent("creative{id}"));
    expect(calls[1]).toContain("/40123");
    expect(calls[2]).toContain("/act_111/adimages");
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/h1.jpg", expect.anything());

    const json = resultJson(result);
    expect(json.account_id).toBe("act_111");
    const images = json.images as Array<Record<string, unknown>>;
    expect(images[0]).toMatchObject({ image_hash: "h1", width: 1080, downloaded: true });
  });

  it("handles carousels with one batched hash lookup and dedupes repeated hashes", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "Carousel",
        account_id: "111",
        object_story_spec: {
          link_data: {
            child_attachments: [
              { image_hash: "h1" },
              { image_hash: "h2" },
              { image_hash: "h1" },
            ],
          },
        },
      }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [
        { hash: "h1", url: "https://cdn.example.com/h1.jpg" },
        { hash: "h2", url: "https://cdn.example.com/h2.jpg" },
      ] })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    const adimagesCalls = fetchCalls().filter((u) => u.includes("/adimages"));
    expect(adimagesCalls).toHaveLength(1);
    expect(adimagesCalls[0]).toContain(encodeURIComponent(JSON.stringify(["h1", "h2"])));
    expect(download).toHaveBeenCalledTimes(2);

    const images = resultJson(result).images as Array<Record<string, unknown>>;
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({ role: "carousel_child", carousel_index: 0 });
    expect(images[1]).toMatchObject({ role: "carousel_child", carousel_index: 1 });
  });

  it("reports hash-only images as unresolved when no account_id can be derived", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "C",
      image_hash: "h1",
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(fetchCalls()).toHaveLength(1);
    expect(download).not.toHaveBeenCalled();

    const json = resultJson(result);
    const images = json.images as Array<Record<string, unknown>>;
    expect(images[0].downloaded).toBe(false);
    expect(String(images[0].error)).toContain("account_id");
    expect((json.warnings as string[]).some((w) => w.includes("account_id"))).toBe(true);
  });

  it("returns video creatives as thumbnail block + signed source URL in metadata", async () => {
    const { handler, download } = registerWithDownload();
    const videoFetch = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "Video creative",
        object_story_spec: { video_data: { video_id: "501" } },
      }))
      .mockResolvedValueOnce(mockFetchResponse({
        id: "501",
        title: "Spot",
        length: 15,
        source: "https://video.example.com/v.mp4?sig=abc",
        picture: "https://cdn.example.com/small.jpg",
        thumbnails: { data: [
          { uri: "https://cdn.example.com/t-small.jpg", width: 128, height: 128 },
          { uri: "https://cdn.example.com/t-big.jpg", width: 1080, height: 1080 },
        ] },
      }));
    vi.stubGlobal("fetch", videoFetch);

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(fetchCalls()[1]).toContain("/501");
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/t-big.jpg", expect.anything());

    const json = resultJson(result);
    const videos = json.videos as Array<Record<string, unknown>>;
    expect(videos[0]).toMatchObject({
      video_id: "501",
      source_url: "https://video.example.com/v.mp4?sig=abc",
      thumbnail_block_index: 0,
      length_seconds: 15,
    });
    expect(String(videos[0].download_hint)).toContain("curl");
    expect((json.warnings as string[]).some((w) => w.includes("expire"))).toBe(true);
    expect(String(result.content[0].text)).toContain("source_url");
  });

  it("skips video resolution when include_videos is false", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Video creative",
      object_story_spec: { video_data: { video_id: "501" } },
    })));

    const result = await handler({ creative_id: "40123", include_videos: false }) as ToolResult;

    expect(fetchCalls()).toHaveLength(1);
    expect(download).not.toHaveBeenCalled();
    expect(resultJson(result).videos).toEqual([]);
  });

  it("caps the cumulative download budget by shrinking maxBytes per download", async () => {
    const seven = 7 * 1024 * 1024;
    const download = vi.fn(async (url: string) => ({
      buffer: Buffer.alloc(seven),
      contentType: "image/jpeg",
      extension: ".jpg" as const,
      finalUrl: new URL(url),
    }));
    const { handler } = registerWithDownload(download);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Feed",
      asset_feed_spec: { images: [
        { url: "https://cdn.example.com/1.jpg" },
        { url: "https://cdn.example.com/2.jpg" },
        { url: "https://cdn.example.com/3.jpg" },
      ] },
    })));

    await handler({ creative_id: "40123" });

    const maxBytesPerCall = download.mock.calls.map((call) => (call[1] as { maxBytes: number }).maxBytes);
    expect(maxBytesPerCall).toEqual([
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      20 * 1024 * 1024 - 2 * seven,
    ]);
  });

  it("strips access_token and userinfo from metadata URLs but downloads the original", async () => {
    const { handler, download } = registerWithDownload();
    const tokenUrl = "https://cdn.example.com/full.jpg?access_token=SECRETTOKEN123&oh=keepme";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "C",
        image_url: tokenUrl,
        object_story_spec: { video_data: { video_id: "501" } },
      }))
      .mockResolvedValueOnce(mockFetchResponse({
        id: "501",
        source: "https://user:pass@video.example.com/v.mp4?access_token=SECRETTOKEN123&sig=ok",
        picture: "https://cdn.example.com/pic.jpg",
      })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(download).toHaveBeenCalledWith(tokenUrl, expect.anything());
    const serialized = JSON.stringify(resultJson(result));
    expect(serialized).not.toContain("SECRETTOKEN123");
    expect(serialized).not.toContain("user:pass@");
    const json = resultJson(result);
    expect((json.images as Array<Record<string, unknown>>)[0].source_url).toContain("oh=keepme");
    expect((json.videos as Array<Record<string, unknown>>)[0].source_url).toContain("sig=ok");
  });

  it("resolves hashes in small mode even when the spec already has a full URL", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "C",
        account_id: "111",
        image_hash: "h1",
        image_url: "https://cdn.example.com/full.jpg",
      }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [
        { hash: "h1", url: "https://cdn.example.com/full.jpg", url_128: "https://cdn.example.com/small.jpg" },
      ] })));

    await handler({ creative_id: "40123", image_size: "small" });

    expect(fetchCalls().some((u) => u.includes("/adimages"))).toBe(true);
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/small.jpg", expect.anything());
  });

  it("still returns the spec thumbnail when the video detail fetch fails", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "Video creative",
        object_story_spec: { video_data: { video_id: "501", image_url: "https://cdn.example.com/spec-thumb.jpg" } },
      }))
      .mockResolvedValueOnce(mockFetchResponse({ error: { message: "video gone", code: 100 } }, { status: 400 })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(download).toHaveBeenCalledWith("https://cdn.example.com/spec-thumb.jpg", expect.anything());
    const json = resultJson(result);
    const videos = json.videos as Array<Record<string, unknown>>;
    expect(videos[0].error).toBeDefined();
    expect(videos[0].thumbnail_block_index).toBe(0);
    const images = json.images as Array<Record<string, unknown>>;
    expect(images[0]).toMatchObject({ role: "video_thumbnail", downloaded: true });
  });

  it("returns clean metadata URLs byte-identical and strips fragment tokens", async () => {
    const { handler } = registerWithDownload();
    const preEncodedUrl = "https://cdn.example.com/a%20b.jpg?sig=x%2By&oh=~z";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "C",
        image_url: preEncodedUrl,
        object_story_spec: { video_data: { video_id: "501" } },
      }))
      .mockResolvedValueOnce(mockFetchResponse({
        id: "501",
        source: "https://video.example.com/v.mp4#access_token=SECRETFRAG",
        picture: "https://cdn.example.com/pic.jpg",
      })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    const json = resultJson(result);
    expect((json.images as Array<Record<string, unknown>>)[0].source_url).toBe(preEncodedUrl);
    expect(JSON.stringify(json)).not.toContain("SECRETFRAG");
  });

  it("does not warn about account_id in small mode when a full URL is available", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "C",
      image_hash: "h1",
      image_url: "https://cdn.example.com/full.jpg",
    })));

    const result = await handler({ creative_id: "40123", image_size: "small" }) as ToolResult;

    expect(download).toHaveBeenCalledWith("https://cdn.example.com/full.jpg", expect.anything());
    const json = resultJson(result);
    expect(json.warnings).toEqual([]);
    expect((json.images as Array<Record<string, unknown>>)[0].downloaded).toBe(true);
  });

  it("uses url_128 for the spec thumbnail in small mode when the video detail fetch fails", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({
        id: "40123",
        name: "Video creative",
        account_id: "111",
        object_story_spec: { video_data: { video_id: "501", image_hash: "th1" } },
      }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [
        { hash: "th1", url: "https://cdn.example.com/thumb-full.jpg", url_128: "https://cdn.example.com/thumb-small.jpg" },
      ] }))
      .mockResolvedValueOnce(mockFetchResponse({ error: { message: "video gone", code: 100 } }, { status: 400 })));

    await handler({ creative_id: "40123", image_size: "small" });

    expect(download).toHaveBeenCalledWith("https://cdn.example.com/thumb-small.jpg", expect.anything());
  });

  it("prefers url_128 when image_size is small", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "40123", name: "C", account_id: "111", image_hash: "h1" }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [
        { hash: "h1", url: "https://cdn.example.com/full.jpg", url_128: "https://cdn.example.com/small.jpg" },
      ] })));

    await handler({ creative_id: "40123", image_size: "small" });

    expect(download).toHaveBeenCalledWith("https://cdn.example.com/small.jpg", expect.anything());
  });

  it("caps returned blocks at max_images and marks the rest skipped", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Feed",
      asset_feed_spec: { images: [
        { url: "https://cdn.example.com/1.jpg" },
        { url: "https://cdn.example.com/2.jpg" },
        { url: "https://cdn.example.com/3.jpg" },
      ] },
    })));

    const result = await handler({ creative_id: "40123", max_images: 2 }) as ToolResult;

    expect(download).toHaveBeenCalledTimes(2);
    const images = resultJson(result).images as Array<Record<string, unknown>>;
    expect(images.filter((i) => i.downloaded)).toHaveLength(2);
    expect(images[2].skipped).toBe("max_images");
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
  });

  it("continues past a failing download and reports the error", async () => {
    const download = vi.fn()
      .mockImplementationOnce(async (url: string) => ({ buffer: Buffer.from("img"), contentType: "image/jpeg", extension: ".jpg" as const, finalUrl: new URL(url) }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce(async (url: string) => ({ buffer: Buffer.from("img"), contentType: "image/jpeg", extension: ".jpg" as const, finalUrl: new URL(url) }));
    const { handler } = registerWithDownload(download);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Feed",
      asset_feed_spec: { images: [
        { url: "https://cdn.example.com/1.jpg" },
        { url: "https://cdn.example.com/2.jpg" },
        { url: "https://cdn.example.com/3.jpg" },
      ] },
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    const images = resultJson(result).images as Array<Record<string, unknown>>;
    expect(images[0]).toMatchObject({ downloaded: true, block_index: 0 });
    expect(images[1]).toMatchObject({ downloaded: false, error: "boom" });
    expect(images[2]).toMatchObject({ downloaded: true, block_index: 1 });
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
  });

  it("refuses images resolving to private IPs when wired to the real downloader", async () => {
    const download = vi.fn(async (url: string) =>
      downloadSafePublicImage(url, {
        resolve: async () => [{ address: "10.0.0.5" }],
      }));
    const { handler } = registerWithDownload(download as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "C",
      image_url: "https://internal.example.com/image.jpg",
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    const images = resultJson(result).images as Array<Record<string, unknown>>;
    expect(images[0].downloaded).toBe(false);
    expect(String(images[0].error)).toMatch(/private IP/);
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(0);
  });

  it("returns a text-only result when the creative has no media", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Empty",
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(download).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(String(result.content[0].text)).toContain("No downloadable media found");
  });

  it("falls back to the upsized thumbnail_url for boosted-post creatives", async () => {
    const { handler, download } = registerWithDownload();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      id: "40123",
      name: "Boosted",
      thumbnail_url: "https://cdn.example.com/thumb.jpg",
      effective_object_story_id: "111_222",
    })));

    const result = await handler({ creative_id: "40123" }) as ToolResult;

    expect(fetchCalls()[0]).toContain("thumbnail_width=1080");
    expect(download).toHaveBeenCalledWith("https://cdn.example.com/thumb.jpg", expect.anything());
    const images = resultJson(result).images as Array<Record<string, unknown>>;
    expect(images[0]).toMatchObject({ role: "thumbnail_fallback", downloaded: true });
  });
});

describe("collectCreativeMedia", () => {
  it("walks all spec locations and dedupes by hash and url", () => {
    const { images, videos } = collectCreativeMedia({
      id: "1",
      name: "c",
      image_hash: "h1",
      image_url: "https://cdn.example.com/h1.jpg",
      object_story_spec: {
        link_data: {
          image_hash: "h1",
          child_attachments: [
            { image_hash: "h2" },
            { video_id: "v1", image_hash: "h3" },
          ],
        },
      },
      asset_feed_spec: {
        images: [{ hash: "h2" }, { url: "https://cdn.example.com/u1.jpg" }],
        videos: [{ video_id: "v1" }, { video_id: "v2", thumbnail_url: "https://cdn.example.com/vt.jpg" }],
      },
    });

    expect(images.map((i) => i.role)).toEqual(["primary", "carousel_child", "asset_feed_image"]);
    expect(videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
    expect(videos[1].specThumbnailUrl).toBe("https://cdn.example.com/vt.jpg");
  });

  it("merges two existing entries when a later reference connects them", () => {
    const { images } = collectCreativeMedia({
      id: "1",
      name: "c",
      image_hash: "h1",
      asset_feed_spec: {
        images: [
          { url: "https://cdn.example.com/u1.jpg" },
          { hash: "h1", url: "https://cdn.example.com/u1.jpg" },
        ],
      },
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      role: "primary",
      hash: "h1",
      url: "https://cdn.example.com/u1.jpg",
    });
  });

  it("merges hash-only and url-only references to the same image", () => {
    const { images } = collectCreativeMedia({
      id: "1",
      name: "c",
      image_url: "https://cdn.example.com/same.jpg",
      asset_feed_spec: {
        images: [{ hash: "h9", url: "https://cdn.example.com/same.jpg" }],
      },
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      role: "primary",
      url: "https://cdn.example.com/same.jpg",
      hash: "h9",
    });
  });
});

describe("pickVideoThumbnailUrl", () => {
  const video = {
    id: "501",
    picture: "https://cdn.example.com/picture.jpg",
    thumbnails: { data: [
      { uri: "https://cdn.example.com/small.jpg", width: 128, height: 128 },
      { uri: "https://cdn.example.com/big.jpg", width: 1080, height: 1080 },
    ] },
  };

  it("prefers the largest thumbnail at full size and picture at small size", () => {
    expect(pickVideoThumbnailUrl(video, "full")).toBe("https://cdn.example.com/big.jpg");
    expect(pickVideoThumbnailUrl(video, "small")).toBe("https://cdn.example.com/picture.jpg");
  });

  it("falls back across sources when fields are missing", () => {
    expect(pickVideoThumbnailUrl({ id: "1", picture: "https://cdn.example.com/p.jpg" }, "full")).toBe("https://cdn.example.com/p.jpg");
    expect(pickVideoThumbnailUrl({ id: "1" }, "small")).toBeUndefined();
  });
});
