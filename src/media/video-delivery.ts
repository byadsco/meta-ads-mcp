import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { downloadSafePublicImage, type SafeImageDownload, type SafeImageDownloadOptions } from "../utils/safe-download.js";
import { isStdioTransport } from "../utils/transport-mode.js";
import {
  audioBlock,
  blobResourceBlock,
  imageBlock,
  resourceLinkBlock,
  safeHostname,
  sanitizeMetadataUrl,
  type ContentBlock,
} from "./content-blocks.js";
import { getFfmpeg, type Ffmpeg, type VideoProbe } from "./ffmpeg.js";
import {
  downloadSafePublicVideo,
  resolveAllowedVideoHostSuffixes,
  type SafeVideoDownload,
  type SafeVideoDownloadOptions,
} from "./safe-video-download.js";
import { assertAllowedHost } from "../utils/safe-http.js";
import { getVideoJobRunner, type VideoJobContext, type VideoJobRunner } from "./video-jobs.js";
import { fbcdnExpiresAt, resourceUriFor, type VideoSource } from "./video-sources.js";

export const VIDEO_EXPIRY_WARNING =
  "Video source URLs are signed, short-lived CDN links — download them promptly. If one has expired, call this tool again to get a fresh URL.";

export type VideoDelivery = "thumbnail" | "frames" | "inline" | "url";
export type FrameLayout = "grid" | "individual" | "both";
export type InlineQuality = "compact" | "original";

const MB = 1024 * 1024;
export const DEFAULT_MAX_INLINE_BYTES = 20 * MB;
export const HTTP_MAX_INLINE_BYTES = 20 * MB;
// The MCP SDK reads stdio through a buffer that, by default, closes the
// transport on any single message above 10 MiB (STDIO_DEFAULT_MAX_BUFFER_SIZE,
// since 1.30.0), on the client side too. The whole tool result has to fit
// under it: base64 adds a third, and images, posters, frames and the JSON
// all share the one message. 6 MiB of raw media leaves the rest as room.
export const STDIO_MAX_INLINE_BYTES = 6 * MB;
export const STDIO_RESPONSE_BYTES_BUDGET = 6 * MB;
export const DEFAULT_VIDEO_TOTAL_BYTES_BUDGET = 30 * MB;

function detectTransport(): "http" | "stdio" {
  return isStdioTransport(process.argv) ? "stdio" : "http";
}

/**
 * Raw media bytes one tool result may carry in total, images included. The
 * tools that attach images before calling deliverVideos size their image
 * budget from this too, so a composite response stays under the transport's
 * message limit rather than only the video part of it.
 */
export function responseBytesBudget(transport: "http" | "stdio" = detectTransport()): number {
  return transport === "stdio" ? STDIO_RESPONSE_BYTES_BUDGET : DEFAULT_VIDEO_TOTAL_BYTES_BUDGET;
}
const DEFAULT_MAX_VIDEOS = 3;
const HARD_MAX_VIDEOS = 3;
const DEFAULT_FRAME_COUNT = 6;
const MAX_FRAME_COUNT = 12;
const DEFAULT_FRAME_WIDTH = 640;
const MAX_FRAME_WIDTH = 1280;
const GRID_TILE_WIDTH = 512;
const GRID_COLUMNS = 3;
const COMPACT_HEIGHT = 480;
const THUMBNAIL_MAX_BYTES = 4 * MB;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function videoMaxBytes(): number {
  return envInt("VIDEO_MAX_BYTES", 150 * MB);
}

export function videoMaxSeconds(): number {
  return envInt("VIDEO_MAX_SECONDS", 240);
}

export interface VideoDeliveryOptions {
  delivery: VideoDelivery;
  frame_count?: number;
  frame_layout?: FrameLayout;
  frame_width?: number;
  include_audio?: boolean;
  quality?: InlineQuality;
  max_inline_bytes?: number;
  max_videos?: number;
}

export type DeliveredMode = VideoDelivery | "skipped_time_budget" | "skipped_size_budget" | "skipped_max_videos" | "none";

export interface DeliveredVideo {
  key: string;
  label: string;
  origin: VideoSource["origin"];
  video_id?: string;
  ad_archive_id?: string;
  card_index?: number;
  title?: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  has_audio?: boolean;
  delivered: {
    mode: DeliveredMode;
    block_indexes: number[];
    bytes?: number;
    transcoded?: boolean;
    frame_layout?: FrameLayout;
    frame_timestamps?: number[];
    resource_uri?: string;
  };
  source_url?: string;
  low_res_url?: string;
  thumbnail_url?: string;
  permalink_url?: string;
  expires_at?: string;
  error?: string;
}

export interface VideoDeliveryResult {
  blocks: ContentBlock[];
  videos: DeliveredVideo[];
  warnings: string[];
  bytes: number;
}

export interface VideoDeliveryDeps {
  downloadVideo?: (url: string, options: SafeVideoDownloadOptions) => Promise<SafeVideoDownload>;
  downloadImage?: (url: string, options?: SafeImageDownloadOptions) => Promise<SafeImageDownload>;
  ffmpeg?: Ffmpeg;
  runner?: VideoJobRunner;
  transport?: "http" | "stdio";
}

export interface VideoDeliveryContext {
  tenantId: string;
  signal?: AbortSignal;
}

interface Budget {
  total: number;
  used: number;
}

function clampInlineBytes(requested: number | undefined, transport: "http" | "stdio"): number {
  const cap = transport === "stdio" ? STDIO_MAX_INLINE_BYTES : HTTP_MAX_INLINE_BYTES;
  return Math.min(Math.max(1 * MB, requested ?? DEFAULT_MAX_INLINE_BYTES), cap);
}

/** Scratch paths must never reach tool output; keep the error code, drop the message. */
function publicErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `Local processing failed (${code})`;
  return err instanceof Error ? err.message : String(err);
}

export function looksLikeMp4(buffer: Buffer): boolean {
  // ISO BMFF: a size box followed by "ftyp" at byte 4.
  return buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp";
}

function baseMeta(source: VideoSource): DeliveredVideo {
  return {
    key: source.key,
    label: source.label,
    origin: source.origin,
    video_id: source.video_id,
    ad_archive_id: source.ad_archive_id,
    card_index: source.card_index,
    title: source.title,
    duration_seconds: source.duration_seconds,
    delivered: { mode: "none", block_indexes: [] },
    source_url: sanitizeMetadataUrl(source.source_url),
    low_res_url: sanitizeMetadataUrl(source.low_res_url),
    thumbnail_url: sanitizeMetadataUrl(source.thumbnail_url),
    permalink_url: sanitizeMetadataUrl(source.permalink_url),
    expires_at: fbcdnExpiresAt(source.source_url ?? source.low_res_url),
    error: source.error,
  };
}

export async function deliverVideos(
  sources: VideoSource[],
  options: VideoDeliveryOptions,
  deps: VideoDeliveryDeps = {},
  ctx: VideoDeliveryContext,
  limits: { totalBytesBudget?: number } = {},
): Promise<VideoDeliveryResult> {
  const downloadVideo = deps.downloadVideo ?? downloadSafePublicVideo;
  const downloadImage = deps.downloadImage ?? downloadSafePublicImage;
  const ffmpeg = deps.ffmpeg ?? getFfmpeg();
  const runner = deps.runner ?? getVideoJobRunner();
  const transport = deps.transport ?? detectTransport();

  const blocks: ContentBlock[] = [];
  const videos: DeliveredVideo[] = [];
  const warnings: string[] = [];
  const ceiling = responseBytesBudget(transport);
  const requestedBudget = limits.totalBytesBudget ?? ceiling;
  const budget: Budget = {
    total: transport === "stdio" ? Math.min(requestedBudget, ceiling) : requestedBudget,
    used: 0,
  };

  const maxVideos = Math.min(options.max_videos ?? DEFAULT_MAX_VIDEOS, HARD_MAX_VIDEOS);
  const selected = sources.slice(0, maxVideos);
  const dropped = sources.slice(maxVideos);
  if (dropped.length > 0) {
    warnings.push(`${dropped.length} video(s) not processed because of max_videos=${maxVideos}: ${dropped.map((s) => s.label).join(", ")}.`);
  }

  const pushBlock = (block: ContentBlock, bytes: number): number => {
    blocks.push(block);
    budget.used += bytes;
    return blocks.length - 1;
  };

  const fits = (bytes: number): boolean => budget.used + bytes <= budget.total;

  // Ad Library records are tenant-controlled input: their preview URLs must stay on Meta CDN hosts.
  const hostSuffixes = resolveAllowedVideoHostSuffixes();
  const allowlistFor = (source: VideoSource): string[] | undefined => (source.origin === "ad_library" ? hostSuffixes : undefined);

  /** A link is only published when it is https and, for Ad Library sources, on an allowed host. */
  const safeLink = (source: VideoSource, url: string | undefined): { url?: string; error?: string } => {
    if (!url) return {};
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return { error: "Video URL rejected: only https links are published." };
      const suffixes = allowlistFor(source);
      if (suffixes) assertAllowedHost(parsed, suffixes, "video");
      return { url: sanitizeMetadataUrl(url) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Video URL rejected." };
    }
  };

  const fetchThumbnail = async (source: VideoSource, signal?: AbortSignal): Promise<{ block: ContentBlock; bytes: number } | undefined> => {
    if (!source.thumbnail_url || signal?.aborted) return undefined;
    try {
      const image = await downloadImage(source.thumbnail_url, { maxBytes: THUMBNAIL_MAX_BYTES, signal, allowedHostSuffixes: allowlistFor(source) });
      return { block: imageBlock(image.buffer, image.contentType), bytes: image.buffer.length };
    } catch (err) {
      logger.warn({ host: safeHostname(source.thumbnail_url), err: err instanceof Error ? err.message : String(err) }, "Video thumbnail download failed");
      return undefined;
    }
  };

  const attachThumbnail = async (source: VideoSource, meta: DeliveredVideo, signal?: AbortSignal): Promise<void> => {
    const thumb = await fetchThumbnail(source, signal);
    if (!thumb || !fits(thumb.bytes)) return;
    meta.delivered.block_indexes.push(pushBlock(thumb.block, thumb.bytes));
  };

  /** Media plus thumbnail are reserved together so the response budget is never overshot. */
  const attachWithThumbnail = async (
    source: VideoSource,
    meta: DeliveredVideo,
    pending: Array<{ block: ContentBlock; bytes: number }>,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const thumb = await fetchThumbnail(source, signal);
    const blocks = thumb ? [thumb, ...pending] : pending;
    const total = blocks.reduce((sum, p) => sum + p.bytes, 0);
    if (!fits(total)) return false;
    for (const p of blocks) {
      meta.delivered.block_indexes.push(pushBlock(p.block, p.bytes));
    }
    meta.delivered.bytes = total - (thumb?.bytes ?? 0);
    return true;
  };

  const fallbackToThumbnail = async (source: VideoSource, meta: DeliveredVideo, job: VideoJobContext | undefined): Promise<void> => {
    const signal = job?.signal ?? ctx.signal;
    if (signal?.aborted) {
      meta.delivered.mode = "skipped_time_budget";
      return;
    }
    await attachThumbnail(source, meta, signal);
    meta.delivered.mode = meta.delivered.block_indexes.length > 0 ? "thumbnail" : "none";
  };

  const needsPipeline = options.delivery === "frames" || options.delivery === "inline";
  let ffmpegAvailable = true;
  if (needsPipeline) {
    ffmpegAvailable = await ffmpeg.isAvailable();
    if (!ffmpegAvailable) {
      // false with no settled answer is a probe that did not complete, not a
      // missing binary; the message must not send anyone to install it.
      const missing = ffmpeg.lastKnownAvailability() === false;
      const cause = missing
        ? "ffmpeg is not installed on this server"
        : "ffmpeg did not respond on this server just now and will be probed again after a short cooldown";
      const hint = missing ? " Set FFMPEG_PATH or install ffmpeg to enable frame extraction." : "";
      warnings.push(
        options.delivery === "frames"
          ? `${cause}, so frames could not be extracted; falling back to thumbnails.${hint}`
          : `${cause}, so videos cannot be transcoded; inline delivery only works when the original file already fits max_inline_bytes.`,
      );
    }
  }

  const processOne = async (source: VideoSource, job: VideoJobContext | undefined): Promise<void> => {
    const meta = baseMeta(source);
    videos.push(meta);

    if (!source.source_url && !source.low_res_url) {
      meta.error = meta.error ?? "No downloadable video URL available.";
      await fallbackToThumbnail(source, meta, job);
      return;
    }

    if (options.delivery === "thumbnail" || (options.delivery === "frames" && !ffmpegAvailable)) {
      const signal = job?.signal ?? ctx.signal;
      if (signal?.aborted) {
        meta.delivered.mode = "skipped_time_budget";
        return;
      }
      await attachThumbnail(source, meta, signal);
      meta.delivered.mode = "thumbnail";
      return;
    }

    if (options.delivery === "url") {
      const links: number[] = [];
      const errors: string[] = [];
      const primary = safeLink(source, source.source_url);
      if (primary.url) {
        links.push(pushBlock(resourceLinkBlock(primary.url, `${source.label} (source)`, { mimeType: "video/mp4", description: "Signed CDN URL; expires" }), 0));
      } else if (primary.error) {
        errors.push(primary.error);
      }
      const lowRes = safeLink(source, source.low_res_url);
      if (lowRes.url) {
        links.push(pushBlock(resourceLinkBlock(lowRes.url, `${source.label} (low-res)`, { mimeType: "video/mp4" }), 0));
      } else if (lowRes.error) {
        errors.push(lowRes.error);
      }
      if (errors.length > 0) meta.error = errors.join(" ");
      meta.delivered.mode = links.length > 0 ? "url" : "none";
      meta.delivered.block_indexes = links;
      return;
    }

    if (!job || job.outOfTime() || job.signal.aborted) {
      meta.delivered.mode = "skipped_time_budget";
      return;
    }

    // One scratch subdirectory per video, removed as soon as the video is done,
    // so a call never holds more than one original on tmpfs at a time.
    const videoDir = path.join(job.dir, randomUUID());
    await fs.mkdir(videoDir);
    try {
      await processDownloaded(source, meta, job, videoDir);
    } finally {
      await fs.rm(videoDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  };

  const processDownloaded = async (source: VideoSource, meta: DeliveredVideo, job: VideoJobContext, videoDir: string): Promise<void> => {
    const downloadUrl = source.low_res_url ?? (source.source_url as string);
    let file: SafeVideoDownload;
    try {
      file = await downloadVideo(downloadUrl, {
        destDir: videoDir,
        maxBytes: videoMaxBytes(),
        signal: job.signal,
      });
    } catch (err) {
      meta.error = `Video download failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn({ host: safeHostname(downloadUrl), event: "video_download_failed" }, meta.error);
      await fallbackToThumbnail(source, meta, job);
      return;
    }

    let probe: VideoProbe | undefined;
    if (ffmpegAvailable) {
      try {
        probe = await ffmpeg.probe(file.path, { maxSeconds: videoMaxSeconds(), signal: job.signal });
        meta.duration_seconds = probe.duration_seconds;
        meta.width = probe.width;
        meta.height = probe.height;
        meta.fps = probe.fps;
        meta.has_audio = probe.has_audio;
      } catch (err) {
        meta.error = `Video rejected: ${err instanceof Error ? err.message : String(err)}`;
        await fallbackToThumbnail(source, meta, job);
        return;
      }
    }

    if (job.outOfTime() || job.signal.aborted) {
      meta.delivered.mode = "skipped_time_budget";
      return;
    }

    if (options.delivery === "frames" && probe) {
      const count = Math.min(Math.max(1, options.frame_count ?? DEFAULT_FRAME_COUNT), MAX_FRAME_COUNT);
      const layout = options.frame_layout ?? "grid";
      const width = Math.min(Math.max(160, options.frame_width ?? DEFAULT_FRAME_WIDTH), MAX_FRAME_WIDTH);
      const common = { outDir: videoDir, durationSeconds: probe.duration_seconds, demuxer: probe.demuxer, signal: job.signal };
      const timestamps: number[] = [];
      const pending: Array<{ block: ContentBlock; bytes: number }> = [];

      if (layout === "grid" || layout === "both") {
        const sheet = await ffmpeg.contactSheet(file.path, { ...common, count, columns: GRID_COLUMNS, tileWidth: GRID_TILE_WIDTH });
        pending.push({ block: imageBlock(sheet.buffer, "image/jpeg"), bytes: sheet.buffer.length });
        timestamps.push(...sheet.timestamps_seconds);
      }
      if (layout === "individual" || layout === "both") {
        const frames = await ffmpeg.extractFrames(file.path, { ...common, count, maxWidth: width });
        for (const frame of frames) {
          pending.push({ block: imageBlock(frame.buffer, "image/jpeg"), bytes: frame.buffer.length });
        }
        if (layout === "individual") timestamps.push(...frames.map((f) => f.timestamp_seconds));
      }
      if (options.include_audio && probe.has_audio) {
        const audio = await ffmpeg.extractAudio(file.path, common);
        pending.push({ block: audioBlock(audio.buffer, audio.mimeType), bytes: audio.buffer.length });
      }

      if (!(await attachWithThumbnail(source, meta, pending, job.signal))) {
        meta.delivered.mode = "skipped_size_budget";
        warnings.push(`${source.label}: frames skipped because the response size budget is exhausted; request fewer videos or frames.`);
        return;
      }
      meta.delivered.mode = "frames";
      meta.delivered.frame_layout = layout;
      meta.delivered.frame_timestamps = timestamps;
      return;
    }

    if (options.delivery === "inline") {
      const cap = clampInlineBytes(options.max_inline_bytes, transport);
      const quality = options.quality ?? "compact";
      let payload: Buffer | undefined;
      let transcoded = false;

      if (!ffmpegAvailable || quality === "original") {
        const original = await fs.readFile(file.path);
        if (!looksLikeMp4(original)) {
          meta.error = "Downloaded file is not a valid MP4 (missing ftyp header).";
          await fallbackToThumbnail(source, meta, job);
          return;
        }
        if (original.length <= cap) {
          payload = original;
        } else if (!ffmpegAvailable) {
          meta.error = `Original video is ${original.length} bytes, above max_inline_bytes=${cap}, and ffmpeg is unavailable to compact it.`;
          await fallbackToThumbnail(source, meta, job);
          return;
        }
      }

      if (!payload && probe) {
        try {
          const compact = await ffmpeg.compact(file.path, {
            outDir: videoDir,
            maxBytes: cap,
            durationSeconds: probe.duration_seconds,
            maxSeconds: videoMaxSeconds(),
            height: COMPACT_HEIGHT,
            demuxer: probe.demuxer,
            signal: job.signal,
          });
          payload = await fs.readFile(compact.path);
          transcoded = true;
        } catch (err) {
          meta.error = publicErrorMessage(err);
          await fallbackToThumbnail(source, meta, job);
          return;
        }
      }

      if (!payload) {
        meta.error = "Video could not be prepared for inline delivery.";
        meta.delivered.mode = "none";
        return;
      }
      const uri = resourceUriFor(source);
      if (!(await attachWithThumbnail(source, meta, [{ block: blobResourceBlock(uri, payload, "video/mp4"), bytes: payload.length }], job.signal))) {
        meta.delivered.mode = "skipped_size_budget";
        warnings.push(`${source.label}: inline video skipped because the response size budget is exhausted.`);
        return;
      }
      meta.delivered.mode = "inline";
      meta.delivered.transcoded = transcoded;
      meta.delivered.resource_uri = uri;
    }
  };

  const heavy = selected.filter((s) => (options.delivery === "frames" || options.delivery === "inline") && (s.source_url || s.low_res_url));
  const light = selected.filter((s) => !heavy.includes(s));

  for (const source of light) {
    await processOne(source, undefined);
  }

  if (heavy.length > 0) {
    // One job per call: the semaphore slot, scratch dir and time budget are shared across the call's videos.
    try {
      await runner.run({ tenantId: ctx.tenantId, signal: ctx.signal }, async (job) => {
        for (const source of heavy) {
          try {
            await processOne(source, job);
          } catch (err) {
            const meta = videos.find((v) => v.key === source.key);
            if (meta) {
              meta.error = publicErrorMessage(err);
              if (meta.delivered.mode === "none") meta.delivered.mode = job.signal.aborted ? "skipped_time_budget" : "none";
            }
          }
        }
      });
    } catch (err) {
      // Busy / rate-limited / aborted before the job started: report per video, never throw.
      const message = err instanceof Error ? err.message : String(err);
      for (const source of heavy) {
        if (videos.some((v) => v.key === source.key)) continue;
        const meta = baseMeta(source);
        meta.error = message;
        meta.delivered.mode = ctx.signal?.aborted ? "skipped_time_budget" : "none";
        videos.push(meta);
      }
      warnings.push(message);
    }
  }

  // Keep the caller's ordering: light videos were processed first.
  videos.sort((a, b) => selected.findIndex((s) => s.key === a.key) - selected.findIndex((s) => s.key === b.key));

  if (videos.some((v) => v.delivered.mode === "skipped_time_budget")) {
    warnings.push("Some videos were skipped because the per-call time budget ran out; call again with fewer videos or a lighter delivery mode.");
  }
  if (videos.some((v) => v.source_url || v.low_res_url)) {
    warnings.push(VIDEO_EXPIRY_WARNING);
  }

  return { blocks, videos, warnings, bytes: budget.used };
}
