import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_VERSION,
  VIDEO_ANALYSIS_SCHEMA,
  analyzeVideoWithGemini,
  createAnalysisCache,
  GeminiAnalysisRateLimitError,
  type VideoAnalysisDeps,
} from "../../src/gemini/video-analysis.js";
import { createGeminiClient, GeminiApiError, type GeminiClient } from "../../src/gemini/client.js";
import type { Ffmpeg } from "../../src/media/ffmpeg.js";
import { createVideoJobRunner } from "../../src/media/video-jobs.js";
import type { VideoSource } from "../../src/media/video-sources.js";
import { createSlidingWindowLimiter } from "../../src/utils/sliding-window-limiter.js";

const KEY = "AQ.test_gemini_fixture_key_000";

function mp4(bytes: number): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypmp42"), Buffer.alloc(Math.max(0, bytes - 12))]);
}

const SOURCE: VideoSource = {
  key: "meta:video:999",
  label: "Video 999",
  origin: "meta",
  video_id: "999",
  source_url: "https://video.xx.fbcdn.net/hd.mp4",
  low_res_url: "https://video.xx.fbcdn.net/sd.mp4",
};

const ANALYSIS = {
  language: "es",
  summary: "Un anuncio con gancho directo.",
  hook: { description_first_3s: "Primer plano del producto", technique: "pattern interrupt", strength_1_5: 4, rationale: "Arranca con movimiento" },
  cta: { present: true, time: "00:12", text: "Compra ahora", type: "SHOP_NOW" },
  transcript: [{ start: "00:00", end: "00:03", text: "Hola" }],
  on_screen_text: [{ time: "00:01", text: "50% OFF" }],
  scenes: [{ start: "00:00", end: "00:05", description: "Producto sobre una mesa" }],
  strengths: ["Hook claro"],
  weaknesses: ["Sin subtítulos"],
  improvement_ideas: ["Añadir subtítulos"],
};

function fakeFfmpeg(overrides: Partial<Ffmpeg> = {}, available = true): Ffmpeg {
  return {
    isAvailable: async () => available,
    lastKnownAvailability: () => available,
    probe: async () => ({ duration_seconds: 15, width: 720, height: 1280, fps: 30, has_audio: true, video_codec: "h264", bytes: 100, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" }),
    extractFrames: async () => [],
    contactSheet: async () => ({ buffer: Buffer.alloc(0), timestamps_seconds: [], columns: 3, rows: 1 }),
    compact: async (_input, options) => {
      const out = path.join(options.outDir, "compact.mp4");
      await fs.writeFile(out, mp4(2048));
      return { path: out, bytes: 2048, height: options.height };
    },
    extractAudio: async () => ({ buffer: Buffer.alloc(0), mimeType: "audio/aac" }),
    ...overrides,
  };
}

function fakeClient(overrides: Partial<GeminiClient> = {}): GeminiClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    validateKey: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => ({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "PROCESSING" })),
    waitForFileActive: vi.fn(async () => ({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "ACTIVE" })),
    generateJson: vi.fn(async () => ({ json: ANALYSIS, usage: { prompt_tokens: 1500, output_tokens: 300, total_tokens: 1800 }, model: "gemini-3.8-flash", finish_reason: "STOP", schema_enforced: true })),
    deleteFile: vi.fn(async () => true),
    ...overrides,
  } as never;
}

function setup(overrides: Partial<VideoAnalysisDeps> = {}, videoBytes = 4096) {
  const downloadVideo = vi.fn(async (url: string, opts: { destDir: string }) => {
    const file = path.join(opts.destDir, "in.mp4");
    await fs.writeFile(file, mp4(videoBytes));
    return { path: file, bytes: videoBytes, contentType: "video/mp4", finalUrl: new URL(url) };
  });
  const client = fakeClient();
  const deps: VideoAnalysisDeps = {
    downloadVideo: downloadVideo as never,
    ffmpeg: fakeFfmpeg(),
    runner: createVideoJobRunner({ maxConcurrent: 2 }),
    client,
    resolveKey: async () => ({ key: KEY, source: "encrypted_user_storage", tenantId: "tenant-1" }),
    limiter: createSlidingWindowLimiter({ limit: 20, windowMs: 3_600_000 }),
    cache: createAnalysisCache(),
    model: "gemini-3.8-flash",
    inlineMaxBytes: 8 * 1024,
    maxUploadBytes: 64 * 1024,
    ...overrides,
  };
  return { deps, client: (deps.client ?? client) as ReturnType<typeof fakeClient>, downloadVideo };
}

const OPTIONS = { language: "es", detail: "standard" as const, quality: "sd" as const };

describe("VIDEO_ANALYSIS_SCHEMA", () => {
  it("only uses JSON Schema keywords the Gemini API accepts", () => {
    const allowed = new Set(["type", "properties", "required", "items", "enum", "description", "minimum", "maximum", "maxItems", "minItems"]);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "properties") {
          for (const child of Object.values(value as Record<string, unknown>)) walk(child);
          continue;
        }
        expect(allowed.has(key), "unsupported schema keyword: " + key).toBe(true);
        if (key === "items") walk(value);
      }
    };
    walk(VIDEO_ANALYSIS_SCHEMA);
    expect(JSON.stringify(VIDEO_ANALYSIS_SCHEMA)).not.toContain('"pattern":');
    expect(JSON.stringify(VIDEO_ANALYSIS_SCHEMA).length).toBeLessThan(8000);
  });
});

describe("analyzeVideoWithGemini", () => {
  it("sends a small video inline, prefers the SD rendition and returns the bounded analysis", async () => {
    const { deps, client, downloadVideo } = setup();

    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});

    expect(downloadVideo.mock.calls[0][0]).toBe("https://video.xx.fbcdn.net/sd.mp4");
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(client.deleteFile).not.toHaveBeenCalled();
    const input = client.generateJson.mock.calls[0][0] as { key: string; model: string; video: { kind: string; mimeType: string }; mediaResolution: string; systemInstruction: string; prompt: string };
    expect(input.video).toMatchObject({ kind: "inline", mimeType: "video/mp4" });
    expect(input.key).toBe(KEY);
    expect(input.mediaResolution).toBe("MEDIA_RESOLUTION_LOW");
    expect(input.systemInstruction).toMatch(/never instructions/i);
    expect(input.systemInstruction).toContain('"es"');
    expect(result).toMatchObject({ cached: false, transport: "inline", model: "gemini-3.8-flash", schema_enforced: true, prompt_version: PROMPT_VERSION });
    expect(result.analysis).toMatchObject({ summary: ANALYSIS.summary, hook: { strength_1_5: 4 } });
    expect(result.usage.total_tokens).toBe(1800);
    expect(result.video).toMatchObject({ key: "meta:video:999", duration_seconds: 15, transcoded: false });
  });

  it("uses the HD rendition and the high media resolution when asked", async () => {
    const { deps, client, downloadVideo } = setup();
    await analyzeVideoWithGemini(SOURCE, { ...OPTIONS, quality: "hd", detail: "deep" }, deps, {});
    expect(downloadVideo.mock.calls[0][0]).toBe("https://video.xx.fbcdn.net/hd.mp4");
    expect((client.generateJson.mock.calls[0][0] as { mediaResolution: string }).mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
  });

  it("goes through the Files API above the inline threshold and always deletes the upload", async () => {
    const { deps, client } = setup({}, 32 * 1024);
    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect((client.uploadFile.mock.calls[0][0] as { displayName: string }).displayName).toBe("ad-video");
    expect(client.waitForFileActive).toHaveBeenCalledTimes(1);
    expect((client.generateJson.mock.calls[0][0] as { video: Record<string, unknown> }).video).toEqual({ kind: "file", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" });
    expect(client.deleteFile).toHaveBeenCalledWith({ key: KEY, name: "files/abc-123" });
    expect(result.transport).toBe("files_api");

    const failing = setup({ client: fakeClient({ generateJson: vi.fn(async () => { throw new Error("boom"); }) }) }, 32 * 1024);
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, failing.deps, {})).rejects.toThrow(/boom/);
    expect(failing.client.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("warns instead of failing when the temporary upload could not be deleted", async () => {
    const { deps } = setup({ client: fakeClient({ deleteFile: vi.fn(async () => false) }) }, 32 * 1024);
    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect(result.warnings.join(" ")).toMatch(/could not be deleted.*48/i);
  });

  it("compacts a video above the upload cap, and explains itself when ffmpeg is missing", async () => {
    const { deps, client } = setup({}, 128 * 1024);
    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect(result.video.transcoded).toBe(true);
    expect((client.generateJson.mock.calls[0][0] as { video: { kind: string } }).video.kind).toBe("inline");

    const noFfmpeg = setup({ ffmpeg: fakeFfmpeg({}, false) }, 128 * 1024);
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, noFfmpeg.deps, {})).rejects.toThrow(/ffmpeg/i);
    expect(noFfmpeg.client.generateJson).not.toHaveBeenCalled();
  });

  it("refuses a file that is not an MP4 when it cannot probe it", async () => {
    const downloadVideo = vi.fn(async (url: string, opts: { destDir: string }) => {
      const file = path.join(opts.destDir, "in.bin");
      await fs.writeFile(file, Buffer.from("<html>not a video</html>"));
      return { path: file, bytes: 24, contentType: "application/octet-stream", finalUrl: new URL(url) };
    });
    const { deps, client } = setup({ downloadVideo: downloadVideo as never, ffmpeg: fakeFfmpeg({}, false) });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})).rejects.toThrow(/not a valid MP4/i);
    expect(client.generateJson).not.toHaveBeenCalled();
  });

  it("labels a webm container correctly", async () => {
    const { deps, client } = setup({
      ffmpeg: fakeFfmpeg({ probe: async () => ({ duration_seconds: 8, width: 640, height: 360, fps: 25, has_audio: false, video_codec: "vp9", bytes: 100, demuxer: "matroska,webm" }) }),
    });
    await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect((client.generateJson.mock.calls[0][0] as { video: { mimeType: string } }).video.mimeType).toBe("video/webm");
  });

  it("resolves the key before downloading anything", async () => {
    const { deps, downloadVideo } = setup({ resolveKey: async () => { throw new Error("No Gemini API key registered"); } });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})).rejects.toThrow(/No Gemini API key/);
    expect(downloadVideo).not.toHaveBeenCalled();
  });

  it("serves a repeat from the cache without billing, scoped to tenant, focus and options", async () => {
    const { deps, client } = setup();
    const first = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    const second = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.analysis).toEqual(first.analysis);
    expect(client.generateJson).toHaveBeenCalledTimes(1);

    await analyzeVideoWithGemini(SOURCE, { ...OPTIONS, focus: "el hook" }, deps, {});
    expect(client.generateJson).toHaveBeenCalledTimes(2);

    const otherTenant = { ...deps, resolveKey: async () => ({ key: KEY, source: "encrypted_user_storage" as const, tenantId: "tenant-2" }) };
    const foreign = await analyzeVideoWithGemini(SOURCE, OPTIONS, otherTenant, {});
    expect(foreign.cached).toBe(false);
    expect(client.generateJson).toHaveBeenCalledTimes(3);
  });

  it("never lets a cached result be mutated by one caller for the next", async () => {
    const { deps } = setup();
    const first = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    (first.analysis as Record<string, unknown>).summary = "tampered";
    const second = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    expect(second.analysis.summary).toBe(ANALYSIS.summary);
  });

  it("caps billable analyses per tenant and refunds the slot when nothing was billed", async () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 3_600_000 });
    const failingDownload = vi.fn(async () => { throw new Error("Video download failed: 403"); });
    const broken = setup({ limiter, downloadVideo: failingDownload as never });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, broken.deps, {})).rejects.toThrow(/download failed/i);

    const working = setup({ limiter });
    await analyzeVideoWithGemini(SOURCE, OPTIONS, working.deps, {});
    const other: VideoSource = { ...SOURCE, key: "meta:video:1000", video_id: "1000" };
    await expect(analyzeVideoWithGemini(other, OPTIONS, working.deps, {})).rejects.toBeInstanceOf(GeminiAnalysisRateLimitError);
    expect(working.client.generateJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the slot spent once Gemini was called, even if the call failed", async () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 3_600_000 });
    const failing = setup({ limiter, client: fakeClient({ generateJson: vi.fn(async () => { throw new Error("quota"); }) }) });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, failing.deps, {})).rejects.toThrow(/quota/);
    const next = setup({ limiter });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, next.deps, {})).rejects.toBeInstanceOf(GeminiAnalysisRateLimitError);
  });

  it("flattens and bounds the focus before it reaches the prompt", async () => {
    const { deps, client } = setup();
    await analyzeVideoWithGemini(SOURCE, { ...OPTIONS, focus: "line one\nline two " + "x".repeat(2000) }, deps, {});
    const prompt = (client.generateJson.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("line one line two");
    expect(prompt).not.toContain(" ");
    expect(prompt.length).toBeLessThan(4000);
  });

  it("bounds whatever Gemini returns and refuses an answer that is not an object", async () => {
    const huge = { ...ANALYSIS, summary: "s".repeat(500_000), transcript: Array.from({ length: 5000 }, () => ({ start: "00:00", text: "t".repeat(2000) })) };
    const big = setup({ client: fakeClient({ generateJson: vi.fn(async () => ({ json: huge, usage: {}, model: "gemini-3.8-flash", schema_enforced: true })) }) });
    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, big.deps, {});
    expect(JSON.stringify(result.analysis).length).toBeLessThan(80_000);
    expect(result.warnings.join(" ")).toMatch(/truncated/i);

    const scalar = setup({ client: fakeClient({ generateJson: vi.fn(async () => ({ json: ["not", "an", "object"], usage: {}, model: "gemini-3.8-flash", schema_enforced: true })) }) });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, scalar.deps, {})).rejects.toThrow(/unexpected shape/i);
  });

  it("fails clearly for a source without any downloadable url", async () => {
    const { deps, downloadVideo } = setup();
    await expect(analyzeVideoWithGemini({ ...SOURCE, source_url: undefined, low_res_url: undefined, error: "still processing" }, OPTIONS, deps, {})).rejects.toThrow(/no downloadable/i);
    expect(downloadVideo).not.toHaveBeenCalled();
  });

  it("stops before the billable call when the caller is already gone", async () => {
    const controller = new AbortController();
    const { deps, client } = setup({
      downloadVideo: (async (url: string, opts: { destDir: string }) => {
        const file = path.join(opts.destDir, "in.mp4");
        await fs.writeFile(file, mp4(4096));
        controller.abort();
        return { path: file, bytes: 4096, contentType: "video/mp4", finalUrl: new URL(url) };
      }) as never,
    });
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, { signal: controller.signal })).rejects.toThrow(/abort/i);
    expect(client.generateJson).not.toHaveBeenCalled();
  });
});

describe("createAnalysisCache", () => {
  it("evicts the oldest entry beyond its capacity and expires entries by age", () => {
    let now = 0;
    const cache = createAnalysisCache({ maxEntries: 2, ttlMs: 1000, now: () => now });
    cache.set("a", { value: 1 } as never);
    cache.set("b", { value: 2 } as never);
    cache.set("c", { value: 3 } as never);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    now = 2000;
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size()).toBeLessThanOrEqual(1);
  });
});

describe("round-1 review fixes (analysis)", () => {
  it("drops non-object entries from the timed lists before caching them", async () => {
    const odd = { ...ANALYSIS, scenes: [null, { start: "00:00", description: "ok" }], transcript: [null, 5], on_screen_text: ["plain", null] };
    const { deps } = setup({ client: fakeClient({ generateJson: vi.fn(async () => ({ json: odd, usage: {}, model: "gemini-3.8-flash", schema_enforced: false })) }) });

    const result = await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});

    expect(result.analysis.scenes).toEqual([{ start: "00:00", description: "ok" }]);
    expect(result.analysis.transcript).toEqual([]);
    expect(result.analysis.on_screen_text).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/entr(y|ies)/i);
  });

  it("separates two datasets that carry the same Ad Library ad", async () => {
    const first = { ...SOURCE, key: "library:123:video:0", origin: "ad_library" as const, ad_archive_id: "123", source_url: "https://video.xx.fbcdn.net/one.mp4", low_res_url: "https://video.xx.fbcdn.net/one.mp4" };
    const second = { ...first, source_url: "https://video.xx.fbcdn.net/two.mp4", low_res_url: "https://video.xx.fbcdn.net/two.mp4" };
    const { deps, client, downloadVideo } = setup();

    const a = await analyzeVideoWithGemini(first, OPTIONS, deps, {});
    const b = await analyzeVideoWithGemini(second, OPTIONS, deps, {});

    expect(a.cached).toBe(false);
    expect(b.cached).toBe(false);
    expect(client.generateJson).toHaveBeenCalledTimes(2);
    expect(downloadVideo.mock.calls.map((c) => c[0])).toEqual(["https://video.xx.fbcdn.net/one.mp4", "https://video.xx.fbcdn.net/two.mp4"]);

    const again = await analyzeVideoWithGemini(second, OPTIONS, deps, {});
    expect(again.cached).toBe(true);
  });

  it("shares one billable analysis between concurrent identical calls", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generateJson = vi.fn(async () => {
      await gate;
      return { json: ANALYSIS, usage: { total_tokens: 1800 }, model: "gemini-3.8-flash", schema_enforced: true };
    });
    const { deps } = setup({ client: fakeClient({ generateJson }) });

    const both = Promise.all([analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {}), analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})]);
    release();
    const [first, second] = await both;

    expect(generateJson).toHaveBeenCalledTimes(1);
    expect([first.cached, second.cached]).toContain(true);
    expect(first.analysis).toEqual(second.analysis);
  });

  it("does not let one caller's failure become another's", async () => {
    let attempt = 0;
    const generateJson = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("first caller aborted");
      return { json: ANALYSIS, usage: {}, model: "gemini-3.8-flash", schema_enforced: true };
    });
    const { deps } = setup({ client: fakeClient({ generateJson }), limiter: createSlidingWindowLimiter({ limit: 5, windowMs: 3_600_000 }) });

    const results = await Promise.allSettled([analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {}), analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(results.some((r) => r.status === "rejected")).toBe(true);
  });

  it("frees the in-flight slot once the work settles", async () => {
    const { deps, client } = setup();
    await analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    const other = { ...SOURCE, key: "meta:video:1000", video_id: "1000", source_url: "https://video.xx.fbcdn.net/other.mp4", low_res_url: "https://video.xx.fbcdn.net/other.mp4" };
    await analyzeVideoWithGemini(other, OPTIONS, deps, {});
    expect(client.generateJson).toHaveBeenCalledTimes(2);
  });

  it("deletes a file whose finalize response was lost", async () => {
    const uploadFile = vi.fn(async () => {
      throw Object.assign(new Error("socket hang up"), { fileName: "files/lost-123" });
    });
    const { deps, client } = setup({ client: fakeClient({ uploadFile }) }, 32 * 1024);
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})).rejects.toThrow(/socket hang up/);
    expect(client.deleteFile).toHaveBeenCalledWith({ key: KEY, name: "files/lost-123" });
  });
});

describe("round-2 review fixes", () => {
  it("does not leave an unobserved rejection behind when nobody joins the work", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { deps } = setup({ downloadVideo: (async () => { throw new Error("download refused"); }) as never });
      await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})).rejects.toThrow(/download refused/);
      // A macrotask is enough for Node to report an unobserved rejection.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not leave one behind when the caller was already gone", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      controller.abort();
      const { deps } = setup();
      await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, { signal: controller.signal })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("lets a joiner stop waiting when its own caller disconnects, without disturbing the work", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generateJson = vi.fn(async () => {
      await gate;
      return { json: ANALYSIS, usage: {}, model: "gemini-3.8-flash", schema_enforced: true };
    });
    const { deps } = setup({ client: fakeClient({ generateJson }) });

    const leader = analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    // Let the leader reach the gate and publish its in-flight entry.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const joinerAbort = new AbortController();
    const joiner = analyzeVideoWithGemini(SOURCE, OPTIONS, deps, { signal: joinerAbort.signal });
    // Aborted only once the joiner is actually waiting on the shared work, so
    // this exercises the abort listener rather than the already-aborted guard.
    await new Promise((resolve) => setTimeout(resolve, 20));
    joinerAbort.abort();

    await expect(joiner).rejects.toThrow(/aborted/i);
    release();
    await expect(leader).resolves.toMatchObject({ cached: false });
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the name to delete when the finalize body is truncated or empty", async () => {
    for (const body of ['{"file":', "", "not json"]) {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc" } }))
        .mockResolvedValueOnce(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
      const client = createGeminiClient({ fetch: fetchMock as never });
      const error = (await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" }).catch((e: unknown) => e)) as GeminiApiError & { fileName?: string };
      expect(error).toBeInstanceOf(GeminiApiError);
      expect(error.fileName, `body ${JSON.stringify(body)} lost the file name`).toMatch(/^files\/mcp-[a-z0-9-]+$/);
    }
  });

  it("lets an attempt that replaced a failed one still be joined and cached", async () => {
    // The first attempt fails, so the joiner falls through and starts its own.
    // A third call must join that retry, and the retry's own cleanup must not
    // remove an entry it does not own.
    let attempt = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generateJson = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("leader failed");
      await gate;
      return { json: ANALYSIS, usage: {}, model: "gemini-3.8-flash", schema_enforced: true };
    });
    const { deps } = setup({ client: fakeClient({ generateJson }), limiter: createSlidingWindowLimiter({ limit: 5, windowMs: 3_600_000 }) });

    const leader = analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    const joiner = analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    await expect(leader).rejects.toThrow(/leader failed/);
    // The joiner is now the owner of the in-flight entry, still gated.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {});
    release();

    await expect(joiner).resolves.toMatchObject({ cached: false });
    await expect(third).resolves.toMatchObject({ cached: true });
    expect(generateJson).toHaveBeenCalledTimes(2);

    // Nothing was stranded: a later identical call is served from the cache.
    await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, {})).resolves.toMatchObject({ cached: true });
    expect(generateJson).toHaveBeenCalledTimes(2);
  });
});
