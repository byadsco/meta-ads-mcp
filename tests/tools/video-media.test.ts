import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVideoMediaTools, type VideoMediaDeps } from "../../src/tools/video-media.js";
import type { Ffmpeg } from "../../src/media/ffmpeg.js";
import { createVideoJobRunner } from "../../src/media/video-jobs.js";
import { cleanupTestToken, createMockMcpServer, mockFetchResponse, setupTestToken } from "../setup.js";

type ToolResult = { content: Array<Record<string, unknown>>; isError?: boolean };

const VIDEO = {
  id: "999",
  title: "Hook test",
  source: "https://video.xx.fbcdn.net/v.mp4?oe=69617495",
  picture: "https://scontent.xx.fbcdn.net/small.jpg",
  thumbnails: { data: [{ uri: "https://scontent.xx.fbcdn.net/big.jpg", width: 1080, height: 1920 }] },
  length: 15.2,
  permalink_url: "https://www.facebook.com/999",
};

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypmp42"), Buffer.alloc(8)]);

function fakeFfmpeg(available = true): Ffmpeg {
  return {
    isAvailable: async () => available,
    probe: async () => ({ duration_seconds: 15.2, width: 1080, height: 1920, fps: 30, has_audio: true, video_codec: "h264", bytes: 16, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" }),
    extractFrames: async (_i, o) => Array.from({ length: o.count }, (_, i) => ({ timestamp_seconds: i + 0.5, buffer: Buffer.from(`f${i}`) })),
    contactSheet: async (_i, o) => ({ buffer: Buffer.from("sheet"), timestamps_seconds: [1, 2], columns: o.columns, rows: 1 }),
    compact: async (_i, o) => {
      const out = path.join(o.outDir, "compact.mp4");
      await fs.writeFile(out, Buffer.from("compact"));
      return { path: out, bytes: 7, height: o.height };
    },
    extractAudio: async () => ({ buffer: Buffer.from("aac"), mimeType: "audio/aac" }),
  };
}

function setup(overrides: Partial<VideoMediaDeps> = {}) {
  const server = createMockMcpServer();
  const deps: VideoMediaDeps = {
    downloadVideo: async (url, opts) => {
      const file = path.join(opts.destDir, "in.mp4");
      await fs.writeFile(file, MP4);
      return { path: file, bytes: MP4.length, contentType: "video/mp4", finalUrl: new URL(url) };
    },
    downloadImage: async (url) => ({ buffer: Buffer.from("img"), contentType: "image/jpeg", extension: ".jpg" as const, finalUrl: new URL(url) }),
    ffmpeg: fakeFfmpeg(),
    runner: createVideoJobRunner({ maxConcurrent: 2 }),
    transport: "http",
    ...overrides,
  };
  registerVideoMediaTools(server as never, deps);
  const byName = (name: string) => server._registeredTools.find((t) => t.name === name)!;
  return { server, deps, byName, handler: byName("ads_get_video_media").handler };
}

function lastJson(result: ToolResult): Record<string, unknown> {
  const last = result.content[result.content.length - 1];
  return JSON.parse(last.text as string) as Record<string, unknown>;
}

const EXTRA = { signal: new AbortController().signal, sendNotification: vi.fn(), requestId: 1 };

describe("ads_get_video_media", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers a read-only tool whose description explains the delivery modes", () => {
    const { server, byName } = setup();
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const tool = byName("ads_get_video_media");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description).toMatch(/inline/);
    expect(tool.description).toMatch(/frames/);
    expect(tool.description).toMatch(/Gemini/);
    expect(tool.description).not.toContain("⚠️");
  });

  it("requires exactly one source id", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn());
    await expect(handler({ delivery: "frames" }, EXTRA)).rejects.toThrow(/exactly one of/i);
    await expect(handler({ video_id: "999", ad_id: "8001", delivery: "frames" }, EXTRA)).rejects.toThrow(/exactly one of/i);
    await expect(handler({ dataset_id: "abcdefghij", delivery: "frames" }, EXTRA)).rejects.toThrow(/ad_archive_id/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("delivers frames for a video_id: summary text, thumbnail + grid image blocks, JSON metadata", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(VIDEO)));

    const result = (await handler({ video_id: "999", delivery: "frames", frame_count: 4 }, EXTRA)) as ToolResult;

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toMatch(/Video 999/);
    expect(result.content[0].text).toMatch(/1\.0s.*2\.0s|grid/i);
    const images = result.content.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    const json = lastJson(result);
    const videos = json.videos as Array<Record<string, unknown>>;
    expect(videos[0]).toMatchObject({ video_id: "999", duration_seconds: 15.2, delivered: { mode: "frames", frame_layout: "grid" } });
    expect(json.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/short-lived/)]));
  });

  it("embeds the mp4 as a resource blob in inline mode", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(VIDEO)));

    const result = (await handler({ video_id: "999", delivery: "inline" }, EXTRA)) as ToolResult;

    const resource = result.content.find((b) => b.type === "resource") as { resource: Record<string, unknown> };
    expect(resource.resource).toMatchObject({ uri: "meta-ads://video/999", mimeType: "video/mp4" });
    expect(Buffer.from(resource.resource.blob as string, "base64").toString()).toBe("compact");
    expect(result.content[0].text).toMatch(/embedded/i);
  });

  it("resolves an ad through its creative and reports truncation by max_videos", async () => {
    const { handler } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "8001", account_id: "1", creative: { id: "7001" } }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { link_data: { child_attachments: [{ video_id: "9101" }, { video_id: "9102" }] } } }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9101" })),
    );

    const result = (await handler({ ad_id: "8001", delivery: "url", max_videos: 1 }, EXTRA)) as ToolResult;
    const json = lastJson(result);
    expect((json.videos as unknown[]).length).toBe(1);
    expect(json.creative_id).toBe("7001");
    expect(json.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/1 more video/)]));
    expect(result.content.some((b) => b.type === "resource_link")).toBe(true);
  });

  it("returns an isError result with guidance when no video could be delivered", async () => {
    const { handler } = setup({ ffmpeg: fakeFfmpeg(false) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ ...VIDEO, source: undefined, thumbnails: undefined, picture: undefined })));

    const result = (await handler({ video_id: "999", delivery: "frames" }, EXTRA)) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no video could be delivered/i);
  });

  it("sends progress notifications when the client supplied a progressToken", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(VIDEO)));
    const sendNotification = vi.fn(async () => undefined);

    await handler({ video_id: "999", delivery: "frames" }, { ...EXTRA, sendNotification, _meta: { progressToken: "p1" } });

    expect(sendNotification).toHaveBeenCalled();
    const first = sendNotification.mock.calls[0][0] as { method: string; params: { progressToken: string } };
    expect(first.method).toBe("notifications/progress");
    expect(first.params.progressToken).toBe("p1");
  });

  it("video_index selects one video beyond the max_videos window", async () => {
    const { handler } = setup();
    const children = Array.from({ length: 5 }, (_, i) => ({ video_id: String(9100 + i) }));
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { link_data: { child_attachments: children } } }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9104" })),
    );

    const result = (await handler({ creative_id: "7001", delivery: "url", video_index: 4 }, EXTRA)) as ToolResult;
    const json = lastJson(result);
    const videos = json.videos as Array<Record<string, unknown>>;
    expect(videos).toHaveLength(1);
    expect(videos[0].video_id).toBe("9104");
  });

  it("rejects video_index together with video_id instead of ignoring it", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn());
    await expect(handler({ video_id: "999", video_index: 2, delivery: "url" }, EXTRA)).rejects.toThrow(/video_index/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("never echoes credentials from source urls", async () => {
    const { handler } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ ...VIDEO, source: "https://video.xx.fbcdn.net/v.mp4?access_token=SECRET123&oe=69617495" })));

    const result = (await handler({ video_id: "999", delivery: "url" }, EXTRA)) as ToolResult;
    expect(JSON.stringify(result.content)).not.toContain("SECRET123");
  });
});
