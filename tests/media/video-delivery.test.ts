import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deliverVideos, responseBytesBudget, type VideoDeliveryDeps } from "../../src/media/video-delivery.js";
import type { VideoSource } from "../../src/media/video-sources.js";
import type { Ffmpeg, VideoProbe } from "../../src/media/ffmpeg.js";
import { createVideoJobRunner } from "../../src/media/video-jobs.js";

const SOURCE: VideoSource = {
  key: "meta:video:123",
  label: "Video 123",
  origin: "meta",
  video_id: "123",
  source_url: "https://video.xx.fbcdn.net/v/clip.mp4?oh=abc&oe=69617495",
  thumbnail_url: "https://scontent.xx.fbcdn.net/t.jpg",
  duration_seconds: 15,
  permalink_url: "https://www.facebook.com/123",
};

const PROBE: VideoProbe = {
  duration_seconds: 15,
  width: 1080,
  height: 1920,
  fps: 30,
  has_audio: true,
  video_codec: "h264",
  bytes: 4_000_000,
  demuxer: "mov,mp4,m4a,3gp,3g2,mj2",
};

function fakeFfmpeg(overrides: Partial<Ffmpeg> = {}, available = true): Ffmpeg & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: async () => available,
    lastKnownAvailability: () => available,
    probe: async () => {
      calls.push("probe");
      return PROBE;
    },
    extractFrames: async (_input, opts) => {
      calls.push(`frames:${opts.count}`);
      return Array.from({ length: opts.count }, (_, i) => ({
        timestamp_seconds: i + 0.5,
        buffer: Buffer.from(`frame${i}`),
      }));
    },
    contactSheet: async (_input, opts) => {
      calls.push(`sheet:${opts.count}`);
      return { buffer: Buffer.from("sheet"), timestamps_seconds: [1, 2, 3], columns: opts.columns, rows: 1 };
    },
    compact: async (_input, opts) => {
      calls.push(`compact:${opts.maxBytes}`);
      const out = path.join(opts.outDir, "compact.mp4");
      await fs.writeFile(out, Buffer.from("compactmp4"));
      return { path: out, bytes: 10, height: opts.height };
    },
    extractAudio: async () => {
      calls.push("audio");
      return { buffer: Buffer.from("aac"), mimeType: "audio/aac" };
    },
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<VideoDeliveryDeps> = {}): VideoDeliveryDeps & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    downloadVideo: async (url, opts) => {
      downloads.push(url);
      const file = path.join(opts.destDir, "in.mp4");
      await fs.writeFile(file, ORIGINAL_MP4);
      return { path: file, bytes: ORIGINAL_MP4.length, contentType: "video/mp4", finalUrl: new URL(url) };
    },
    downloadImage: async (url) => ({
      buffer: Buffer.from(`img:${url}`),
      contentType: "image/jpeg",
      extension: ".jpg",
      finalUrl: new URL(url),
    }),
    ffmpeg: fakeFfmpeg(),
    runner: createVideoJobRunner({ maxConcurrent: 2 }),
    transport: "http",
    ...overrides,
  };
}

const CTX = { tenantId: "t1" };
// Minimal ISO BMFF header: 4-byte box size, "ftyp", brand "mp42", then padding.
const ORIGINAL_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypmp42"), Buffer.alloc(8)]);

describe("deliverVideos", () => {
  it("thumbnail mode returns the thumbnail image and the signed url without downloading the video", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos([SOURCE], { delivery: "thumbnail" }, deps, CTX);

    expect(deps.downloads).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(result.videos[0]).toMatchObject({
      key: "meta:video:123",
      delivered: { mode: "thumbnail", block_indexes: [0] },
      source_url: SOURCE.source_url,
      expires_at: "2026-01-09T21:35:17.000Z",
    });
    expect(result.warnings.some((w) => /short-lived/.test(w))).toBe(true);
  });

  it("url mode returns resource_link blocks with a name and no bytes", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos([{ ...SOURCE, low_res_url: "https://video.xx.fbcdn.net/sd.mp4" }], { delivery: "url" }, deps, CTX);

    expect(deps.downloads).toEqual([]);
    const links = result.blocks.filter((b) => b.type === "resource_link");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ type: "resource_link", uri: SOURCE.source_url, name: "Video 123 (source)", mimeType: "video/mp4" });
    expect(links[1]).toMatchObject({ uri: "https://video.xx.fbcdn.net/sd.mp4", name: "Video 123 (low-res)" });
    expect(result.videos[0].delivered.mode).toBe("url");
  });

  it("frames mode downloads, probes and returns a contact sheet by default plus the thumbnail", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos([SOURCE], { delivery: "frames", frame_count: 6 }, deps, CTX);

    expect(deps.downloads).toEqual([SOURCE.source_url]);
    expect((deps.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toEqual(["probe", "sheet:6"]);
    const images = result.blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(result.videos[0]).toMatchObject({
      duration_seconds: 15,
      width: 1080,
      height: 1920,
      has_audio: true,
      delivered: { mode: "frames", frame_layout: "grid", frame_timestamps: [1, 2, 3] },
    });
    expect(result.videos[0].delivered.block_indexes).toHaveLength(2);
  });

  it("frames mode with individual layout returns one image block per frame and optional audio", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos(
      [SOURCE],
      { delivery: "frames", frame_count: 3, frame_layout: "individual", include_audio: true },
      deps,
      CTX,
    );

    expect((deps.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toEqual(["probe", "frames:3", "audio"]);
    expect(result.blocks.filter((b) => b.type === "image")).toHaveLength(4);
    const audio = result.blocks.find((b) => b.type === "audio");
    expect(audio).toMatchObject({ type: "audio", mimeType: "audio/aac", data: Buffer.from("aac").toString("base64") });
    expect(result.videos[0].delivered.frame_timestamps).toEqual([0.5, 1.5, 2.5]);
  });

  it("prefers the low-res url for download when present", async () => {
    const deps = fakeDeps();
    await deliverVideos([{ ...SOURCE, low_res_url: "https://video.xx.fbcdn.net/sd.mp4" }], { delivery: "frames" }, deps, CTX);
    expect(deps.downloads).toEqual(["https://video.xx.fbcdn.net/sd.mp4"]);
  });

  it("inline mode compacts the video and embeds it as a resource blob with the video mime type", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos([SOURCE], { delivery: "inline", max_inline_bytes: 5_000_000 }, deps, CTX);

    expect((deps.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toEqual(["probe", "compact:5000000"]);
    const resource = result.blocks.find((b) => b.type === "resource");
    expect(resource).toMatchObject({
      type: "resource",
      resource: { uri: "meta-ads://video/123", mimeType: "video/mp4", blob: Buffer.from("compactmp4").toString("base64") },
    });
    expect(result.blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(result.videos[0].delivered).toMatchObject({ mode: "inline", transcoded: true, bytes: 10 });
  });

  it("inline mode with quality=original embeds the download untouched when it fits", async () => {
    const deps = fakeDeps();
    const result = await deliverVideos([SOURCE], { delivery: "inline", quality: "original", max_inline_bytes: 1_000 }, deps, CTX);

    expect((deps.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toEqual(["probe"]);
    const resource = result.blocks.find((b) => b.type === "resource") as { resource: { blob: string } };
    expect(Buffer.from(resource.resource.blob, "base64").equals(ORIGINAL_MP4)).toBe(true);
    expect(result.videos[0].delivered.transcoded).toBe(false);
  });

  it("caps max_inline_bytes at 20 MB over http and 6 MB over stdio", async () => {
    const http = fakeDeps({ transport: "http" });
    await deliverVideos([SOURCE], { delivery: "inline", max_inline_bytes: 200_000_000 }, http, CTX);
    expect((http.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toContain(`compact:${20 * 1024 * 1024}`);

    const stdio = fakeDeps({ transport: "stdio" });
    await deliverVideos([SOURCE], { delivery: "inline", max_inline_bytes: 200_000_000 }, stdio, CTX);
    expect((stdio.ffmpeg as ReturnType<typeof fakeFfmpeg>).calls).toContain(`compact:${6 * 1024 * 1024}`);
  });

  it("exposes the whole-response budget per transport for the tools that attach images first", () => {
    expect(responseBytesBudget("http")).toBe(30 * 1024 * 1024);
    expect(responseBytesBudget("stdio")).toBe(6 * 1024 * 1024);
  });

  it("caps the per-call media budget at 6 MB over stdio even when the caller asks for more", async () => {
    // A compact rendition that ignores the cap it was given and comes back at 7 MB.
    const sevenMb = async (_input: string, o: { outDir: string; height: number }) => {
      const out = path.join(o.outDir, "compact.mp4");
      await fs.writeFile(out, Buffer.alloc(7 * 1024 * 1024, 1));
      return { path: out, bytes: 7 * 1024 * 1024, height: o.height };
    };

    const http = fakeDeps({ transport: "http", ffmpeg: fakeFfmpeg({ compact: sevenMb }) });
    const overHttp = await deliverVideos([SOURCE], { delivery: "inline" }, http, CTX, { totalBytesBudget: 200 * 1024 * 1024 });
    expect(overHttp.videos[0].delivered.mode).toBe("inline");

    const stdio = fakeDeps({ transport: "stdio", ffmpeg: fakeFfmpeg({ compact: sevenMb }) });
    const overStdio = await deliverVideos([SOURCE], { delivery: "inline" }, stdio, CTX, { totalBytesBudget: 200 * 1024 * 1024 });
    expect(overStdio.videos[0].delivered.mode).toBe("skipped_size_budget");
  });

  it("degrades frames to thumbnail with a warning when ffmpeg is unavailable", async () => {
    const deps = fakeDeps({ ffmpeg: fakeFfmpeg({}, false) });
    const result = await deliverVideos([SOURCE], { delivery: "frames" }, deps, CTX);

    expect(deps.downloads).toEqual([]);
    expect(result.videos[0].delivered.mode).toBe("thumbnail");
    expect(result.warnings.some((w) => /ffmpeg/i.test(w))).toBe(true);
  });

  it("inline without ffmpeg falls back to passthrough only when the mp4 signature checks out and the file fits", async () => {
    const deps = fakeDeps({ ffmpeg: fakeFfmpeg({}, false) });
    const ok = await deliverVideos([SOURCE], { delivery: "inline", max_inline_bytes: 1_000 }, deps, CTX);
    expect(ok.videos[0].delivered).toMatchObject({ mode: "inline", transcoded: false });

    const bad = fakeDeps({
      ffmpeg: fakeFfmpeg({}, false),
      downloadVideo: async (url, opts) => {
        const file = path.join(opts.destDir, "in.bin");
        await fs.writeFile(file, Buffer.from("<html>not a video</html>"));
        return { path: file, bytes: 24, contentType: "application/octet-stream", finalUrl: new URL(url) };
      },
    });
    const rejected = await deliverVideos([SOURCE], { delivery: "inline", max_inline_bytes: 1_000 }, bad, CTX);
    expect(rejected.videos[0].delivered.mode).toBe("thumbnail");
    expect(rejected.videos[0].error).toMatch(/not a valid MP4/);
  });

  it("records a per-video error instead of failing the whole call", async () => {
    const deps = fakeDeps({
      downloadVideo: async () => {
        throw new Error("HTTP 403");
      },
    });
    const result = await deliverVideos([SOURCE, { ...SOURCE, key: "meta:video:456", video_id: "456", label: "Video 456" }], { delivery: "frames" }, deps, CTX);

    expect(result.videos).toHaveLength(2);
    expect(result.videos[0].error).toMatch(/HTTP 403/);
    expect(result.videos[0].delivered.mode).toBe("thumbnail");
  });

  it("stops with skipped_time_budget when the job runs out of time", async () => {
    let now = 0;
    const runner = createVideoJobRunner({ maxConcurrent: 2, budgetMs: 100, now: () => now });
    const ffmpeg = fakeFfmpeg({
      probe: async () => {
        now += 200;
        return PROBE;
      },
    });
    const deps = fakeDeps({ runner, ffmpeg });
    const second = { ...SOURCE, key: "meta:video:456", video_id: "456", label: "Video 456" };

    const result = await deliverVideos([SOURCE, second], { delivery: "frames" }, deps, CTX);

    expect(result.videos[1].delivered.mode).toBe("skipped_time_budget");
    expect(result.warnings.some((w) => /time budget/.test(w))).toBe(true);
  });

  it("sanitizes credentials out of echoed urls and never returns more than max_videos", async () => {
    const deps = fakeDeps();
    const leaky = { ...SOURCE, source_url: "https://user:pw@video.xx.fbcdn.net/v.mp4?access_token=SECRET&oe=69617495" };
    const result = await deliverVideos([leaky, { ...SOURCE, key: "k2" }, { ...SOURCE, key: "k3" }], { delivery: "url", max_videos: 2 }, deps, CTX);

    expect(result.videos).toHaveLength(2);
    expect(JSON.stringify(result.videos)).not.toContain("SECRET");
    expect(JSON.stringify(result.videos)).not.toContain("user:pw");
    expect(result.warnings.some((w) => /max_videos/.test(w))).toBe(true);
  });

  it("removes each video's scratch files before starting the next one", async () => {
    const seen: string[] = [];
    const deps = fakeDeps({
      downloadVideo: async (url, opts) => {
        // Every earlier original must already be gone when a new download starts.
        for (const prior of seen) {
          await expect(fs.stat(prior)).rejects.toThrow();
        }
        const file = path.join(opts.destDir, "in.mp4");
        await fs.writeFile(file, ORIGINAL_MP4);
        seen.push(file);
        return { path: file, bytes: ORIGINAL_MP4.length, contentType: "video/mp4", finalUrl: new URL(url) };
      },
    });
    const second = { ...SOURCE, key: "meta:video:456", video_id: "456" };
    const result = await deliverVideos([SOURCE, second], { delivery: "frames" }, deps, CTX);
    expect(result.videos.map((v) => v.delivered.mode)).toEqual(["frames", "frames"]);
    expect(seen).toHaveLength(2);
    expect(path.dirname(seen[0])).not.toBe(path.dirname(seen[1]));
  });

  it("never exceeds the total bytes budget once the thumbnail is counted", async () => {
    const deps = fakeDeps({
      downloadImage: async (url) => ({ buffer: Buffer.alloc(400), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) }),
      ffmpeg: fakeFfmpeg({
        contactSheet: async (_i, opts) => ({ buffer: Buffer.alloc(700), timestamps_seconds: [1], columns: opts.columns, rows: 1 }),
      }),
    });
    const result = await deliverVideos([SOURCE], { delivery: "frames" }, deps, CTX, { totalBytesBudget: 1000 });
    expect(result.bytes).toBeLessThanOrEqual(1000);
    expect(result.videos[0].delivered.mode).toBe("skipped_size_budget");
  });

  it("stops processing and skips fallbacks once the job signal is aborted", async () => {
    const controller = new AbortController();
    const thumbnailCalls: string[] = [];
    const deps = fakeDeps({
      downloadImage: async (url) => {
        thumbnailCalls.push(url);
        return { buffer: Buffer.alloc(1), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) };
      },
      downloadVideo: async () => {
        controller.abort();
        throw new Error("Video download aborted");
      },
    });
    const second = { ...SOURCE, key: "meta:video:456", video_id: "456" };
    const result = await deliverVideos([SOURCE, second], { delivery: "frames" }, deps, { tenantId: "t1", signal: controller.signal });
    expect(thumbnailCalls).toEqual([]);
    expect(result.videos.map((v) => v.delivered.mode)).toEqual(["skipped_time_budget", "skipped_time_budget"]);
  });

  it("passes the job signal to thumbnail downloads", async () => {
    let received: AbortSignal | undefined;
    const deps = fakeDeps({
      downloadImage: async (url, opts) => {
        received = opts?.signal;
        return { buffer: Buffer.alloc(1), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) };
      },
    });
    await deliverVideos([SOURCE], { delivery: "frames" }, deps, CTX);
    expect(received).toBeInstanceOf(AbortSignal);
  });

  it("skips thumbnail fallbacks for url-less sources once the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const thumbnailCalls: string[] = [];
    const deps = fakeDeps({
      downloadImage: async (url) => {
        thumbnailCalls.push(url);
        return { buffer: Buffer.alloc(1), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) };
      },
    });
    const noUrl = { ...SOURCE, source_url: undefined, low_res_url: undefined };
    const result = await deliverVideos([noUrl], { delivery: "frames" }, deps, { tenantId: "t1", signal: controller.signal });
    expect(thumbnailCalls).toEqual([]);
    expect(result.videos[0].delivered.mode).toBe("skipped_time_budget");
  });

  it("uses the job signal for thumbnails when ffmpeg is missing and a job exists", async () => {
    let received: AbortSignal | undefined;
    const deps = fakeDeps({
      ffmpeg: fakeFfmpeg({}, false),
      downloadImage: async (url, opts) => {
        received = opts?.signal;
        return { buffer: Buffer.alloc(1), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) };
      },
    });
    const ctxSignal = new AbortController().signal;
    await deliverVideos([SOURCE], { delivery: "frames" }, deps, { tenantId: "t1", signal: ctxSignal });
    expect(received).toBeInstanceOf(AbortSignal);
  });

  it("never leaks scratch paths from local processing errors", async () => {
    const deps = fakeDeps({
      ffmpeg: fakeFfmpeg({
        compact: async () => {
          throw Object.assign(new Error("ENOENT: no such file, open /tmp/meta-ads-video-abc/x.mp4"), { code: "ENOENT" });
        },
      }),
    });
    const result = await deliverVideos([SOURCE], { delivery: "inline" }, deps, CTX);
    expect(result.videos[0].error).toBe("Local processing failed (ENOENT)");
    expect(JSON.stringify(result.videos)).not.toContain("/tmp/");
  });

  it("downloads Ad Library thumbnails behind the Meta CDN host allowlist", async () => {
    let received: string[] | undefined;
    const deps = fakeDeps({
      downloadImage: async (url, opts) => {
        received = opts?.allowedHostSuffixes;
        return { buffer: Buffer.alloc(1), contentType: "image/jpeg", extension: ".jpg", finalUrl: new URL(url) };
      },
    });
    const library = { ...SOURCE, key: "library:1:video:0", origin: "ad_library" as const, ad_archive_id: "12345678901", card_index: 0 };
    await deliverVideos([library], { delivery: "thumbnail" }, deps, CTX);
    expect(received).toEqual(expect.arrayContaining([".fbcdn.net"]));
  });

  it("url mode only links https urls on allowed hosts and never emits a block without a uri", async () => {
    const deps = fakeDeps();
    const bad = [
      { ...SOURCE, key: "k1", source_url: "file:///etc/passwd", low_res_url: undefined },
      { ...SOURCE, key: "k2", source_url: "javascript:alert(1)", low_res_url: undefined },
      { ...SOURCE, key: "k3", origin: "ad_library" as const, ad_archive_id: "12345678901", card_index: 0, source_url: "https://evil.example.com/v.mp4", low_res_url: undefined },
    ];
    const result = await deliverVideos(bad, { delivery: "url", max_videos: 3 }, deps, CTX);
    expect(result.blocks.filter((b) => b.type === "resource_link")).toHaveLength(0);
    for (const v of result.videos) {
      expect(v.delivered.mode).toBe("none");
      expect(v.error).toMatch(/not an allowed|https/);
    }
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("enforces the total bytes budget across videos", async () => {
    const deps = fakeDeps({
      ffmpeg: fakeFfmpeg({
        contactSheet: async (_i, opts) => ({ buffer: Buffer.alloc(600), timestamps_seconds: [1], columns: opts.columns, rows: 1 }),
      }),
    });
    const second = { ...SOURCE, key: "meta:video:456", video_id: "456", thumbnail_url: undefined };
    const result = await deliverVideos([{ ...SOURCE, thumbnail_url: undefined }, second], { delivery: "frames" }, deps, CTX, { totalBytesBudget: 1000 });

    expect(result.videos[0].delivered.mode).toBe("frames");
    expect(result.videos[1].delivered.mode).toBe("skipped_size_budget");
  });
});
