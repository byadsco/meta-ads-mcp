import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveTenantId } from "../auth/tenant.js";
import { validateApifyId } from "../apify/client.js";
import { textBlock } from "../media/content-blocks.js";
import {
  deliverVideos,
  type DeliveredVideo,
  type VideoDeliveryDeps,
  type VideoDeliveryOptions,
} from "../media/video-delivery.js";
import { resolveMetaVideoSourcesWithInfo, type VideoSource } from "../media/video-sources.js";
import { resolveAdLibraryVideoSources as defaultResolveAdLibraryVideoSources } from "../media/ad-library-sources.js";
import { READ } from "./_register.js";

export type VideoMediaDeps = VideoDeliveryDeps & {
  resolveAdLibraryVideoSources?: (input: { dataset_id: string; ad_archive_id: string; hint_offset?: number; video_index?: number }) => Promise<VideoSource[]>;
};

const AD_ARCHIVE_ID_PATTERN = /^\d{5,25}$/;

export const videoSourceInputSchema = {
  video_id: z.string().optional().describe("Meta video ID (from ads_get_ad_videos / ads_get_video_details)"),
  ad_id: z.string().optional().describe("Ad ID — every video in its creative is resolved"),
  creative_id: z.string().optional().describe("Creative ID (alternative to ad_id)"),
  dataset_id: z.string().optional().describe("Apify dataset ID of an Ad Library scrape (pair with ad_archive_id)"),
  ad_archive_id: z.string().optional().describe("Ad Library ad_archive_id inside dataset_id"),
  hint_offset: z.number().int().min(0).optional().describe("Offset of the ad inside the dataset, as reported by ads_library_get_results — skips the scan"),
  video_index: z.number().int().min(0).max(99).optional().describe("Pick one video by its position in the resolved list (0-based; e.g. a carousel or DCO card beyond max_videos)"),
};

export interface VideoSourceInput {
  video_id?: string;
  ad_id?: string;
  creative_id?: string;
  dataset_id?: string;
  ad_archive_id?: string;
  hint_offset?: number;
  video_index?: number;
}

export function assertSingleVideoSource(input: VideoSourceInput): "meta" | "ad_library" {
  const metaIds = [input.video_id, input.ad_id, input.creative_id].filter(Boolean).length;
  const library = Boolean(input.dataset_id || input.ad_archive_id);
  if (metaIds + (library ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of video_id, ad_id, creative_id, or dataset_id + ad_archive_id.");
  }
  if (input.video_id && input.video_index !== undefined) {
    throw new Error("video_index applies to ad_id, creative_id or dataset_id sources; a video_id already identifies one video.");
  }
  if (library) {
    if (!input.dataset_id || !input.ad_archive_id) {
      throw new Error("Ad Library videos need both dataset_id and ad_archive_id.");
    }
    validateApifyId(input.dataset_id, "dataset");
    if (!AD_ARCHIVE_ID_PATTERN.test(input.ad_archive_id)) {
      throw new Error(`Invalid ad_archive_id "${input.ad_archive_id}": expected 5-25 digits.`);
    }
    return "ad_library";
  }
  return "meta";
}

export async function resolveVideoSources(
  input: VideoSourceInput & { max_videos?: number },
  deps: VideoMediaDeps,
): Promise<{ sources: VideoSource[]; truncated: number; creative_id?: string; account_id?: string }> {
  const origin = assertSingleVideoSource(input);
  const pick = (all: VideoSource[]): { sources: VideoSource[]; truncated: number } => {
    if (input.video_index !== undefined) {
      const chosen = all[input.video_index];
      if (!chosen) {
        throw new Error(`video_index ${input.video_index} is out of range: this source has ${all.length} addressable video(s) (the record may list more than the pipeline keeps).`);
      }
      return { sources: [chosen], truncated: 0 };
    }
    const max = Math.max(1, input.max_videos ?? 3);
    return { sources: all.slice(0, max), truncated: Math.max(0, all.length - max) };
  };
  if (origin === "ad_library") {
    const resolveLibrary = deps.resolveAdLibraryVideoSources ?? defaultResolveAdLibraryVideoSources;
    const all = await resolveLibrary({
      dataset_id: input.dataset_id as string,
      ad_archive_id: input.ad_archive_id as string,
      hint_offset: input.hint_offset,
      video_index: input.video_index,
    });
    // With video_index the resolver already returns the single addressed video.
    return input.video_index !== undefined ? { sources: all.slice(0, 1), truncated: 0 } : pick(all);
  }
  const info = await resolveMetaVideoSourcesWithInfo({
    video_id: input.video_id,
    ad_id: input.ad_id,
    creative_id: input.creative_id,
    max_videos: input.max_videos,
    video_index: input.video_index,
  });
  // resolveMetaVideoSourcesWithInfo already applies max_videos / video_index and reports truncation.
  return info;
}

type ToolExtra = {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
};

export function progressReporter(extra: ToolExtra | undefined) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) {
    return async (_progress: number, _total: number, _message: string): Promise<void> => undefined;
  }
  return async (progress: number, total: number, message: string): Promise<void> => {
    try {
      await extra.sendNotification?.({ method: "notifications/progress", params: { progressToken: token, progress, total, message } });
    } catch {
      // Progress is best-effort; a closed stream must not fail the tool.
    }
  };
}

export function describeDelivered(video: DeliveredVideo): string {
  const dims = video.width && video.height ? ` ${video.width}x${video.height}` : "";
  const dur = video.duration_seconds ? ` ${video.duration_seconds.toFixed(1)}s` : "";
  const head = `${video.label}${dur}${dims}${video.has_audio === false ? " (no audio)" : ""}`;
  switch (video.delivered.mode) {
    case "frames": {
      const ts = (video.delivered.frame_timestamps ?? []).map((t) => `${t.toFixed(1)}s`).join(", ");
      const layout = video.delivered.frame_layout === "grid"
        ? "one contact-sheet image (read left-to-right, top-to-bottom)"
        : video.delivered.frame_layout === "both"
          ? "a contact sheet followed by individual frames"
          : "individual frame images";
      return `${head}: ${layout} at ${ts}. Content block indexes: ${video.delivered.block_indexes.join(", ")}.`;
    }
    case "inline":
      return `${head}: MP4 embedded as resource block ${video.delivered.block_indexes[video.delivered.block_indexes.length - 1]} (${video.delivered.resource_uri}, ${Math.round((video.delivered.bytes ?? 0) / 1024)} KB${video.delivered.transcoded ? ", transcoded to a compact rendition" : ", original file"}). A thumbnail image precedes it.`;
    case "url":
      return `${head}: signed CDN URL(s) returned as resource_link blocks${video.expires_at ? `, valid until ${video.expires_at}` : ""}.`;
    case "thumbnail":
      return `${head}: thumbnail image only${video.error ? ` — ${video.error}` : ""}.`;
    case "skipped_time_budget":
      return `${head}: skipped, the per-call time budget ran out.`;
    case "skipped_size_budget":
      return `${head}: skipped, the response size budget is exhausted.`;
    default:
      return `${head}: not delivered${video.error ? ` — ${video.error}` : ""}.`;
  }
}

export function registerVideoMediaTools(server: McpServer, deps: VideoMediaDeps = {}): void {
  server.registerTool(
    "ads_get_video_media",
    {
      description:
        "Fetch an ad video so a model can actually analyze it — own-account videos (video_id / ad_id / creative_id) or Meta Ad Library videos (dataset_id + ad_archive_id). " +
        "delivery=frames (default): the server extracts real keyframes with ffmpeg and returns them as image blocks any multimodal model can see (grid contact sheet by default; frame_layout=individual for one image per frame; include_audio adds an audio/aac block). " +
        "delivery=inline: embeds the MP4 itself as a resource blob (video/mp4) for clients whose model ingests video natively, e.g. Gemini CLI or agents on the Gemini API — no intermediary needed. Payloads are large: up to 20 MiB per video over HTTP; over stdio this server caps a whole result at 6 MiB of raw media, because clients on the TypeScript MCP SDK close the connection on a message above 10 MiB by default. Use frames for models that read images rather than video. " +
        "delivery=url: only signed CDN links (short-lived) as resource_link blocks. delivery=thumbnail: poster image only. " +
        "Returns a text summary, the media blocks, then JSON metadata (duration, dimensions, fps, audio, block indexes, expiry).",
      inputSchema: {
        ...videoSourceInputSchema,
        delivery: z.enum(["frames", "inline", "url", "thumbnail"]).default("frames"),
        frame_count: z.number().int().min(1).max(12).default(6).describe("Frames to sample, evenly spaced (frames mode)"),
        frame_layout: z.enum(["grid", "individual", "both"]).default("grid").describe("grid = one contact sheet (cheapest on context); individual = one image per frame"),
        frame_width: z.number().int().min(160).max(1280).default(640).describe("Width of individual frames in px"),
        include_audio: z.boolean().default(false).describe("Also return the audio track as an audio/aac block (frames mode; only useful for audio-capable models)"),
        quality: z.enum(["compact", "original"]).default("compact").describe("inline mode: compact = 480p/10fps h264 transcode that fits max_inline_bytes; original = embed the CDN file untouched if it fits"),
        max_inline_bytes: z.number().int().min(1_048_576).max(52_428_800).default(20_971_520).describe("inline mode size cap in bytes; clamped to 20 MiB over HTTP and 6 MiB over stdio, where MCP SDK clients read through a 10 MiB buffer by default"),
        max_videos: z.number().int().min(1).max(3).default(3).describe("Cap on videos processed per call (carousels / asset feeds)"),
      },
      annotations: { ...READ },
    },
    async (args, extra) => {
      const {
        delivery = "frames",
        frame_count = 6,
        frame_layout = "grid",
        frame_width = 640,
        include_audio = false,
        quality = "compact",
        max_inline_bytes = 20 * 1024 * 1024,
        max_videos = 3,
        ...sourceInput
      } = args;
      const report = progressReporter(extra as ToolExtra | undefined);
      const tenantId = resolveTenantId({ feature: "video" });

      await report(0, 3, "Resolving video sources");
      const resolved = await resolveVideoSources({ ...sourceInput, max_videos }, deps);
      const warnings: string[] = [];
      if (resolved.truncated > 0) {
        warnings.push(`${resolved.truncated} more video(s) exist beyond max_videos=${max_videos}; raise max_videos (up to 3) or call again with video_index to pick one.`);
      }

      await report(1, 3, `Processing ${resolved.sources.length} video(s) (${delivery})`);
      const options: VideoDeliveryOptions = {
        delivery,
        frame_count,
        frame_layout,
        frame_width,
        include_audio,
        quality,
        max_inline_bytes,
        max_videos,
      };
      const result = await deliverVideos(resolved.sources, options, deps, {
        tenantId,
        signal: (extra as ToolExtra | undefined)?.signal,
      });
      await report(3, 3, "Done");

      const allWarnings = [...warnings, ...result.warnings];
      const delivered = result.videos.filter((v) => ["frames", "inline", "url", "thumbnail"].includes(v.delivered.mode) && v.delivered.block_indexes.length > 0);
      const summary: string[] = [];
      if (resolved.sources.length === 0) {
        summary.push("No videos found for the given source.");
      } else if (delivered.length === 0) {
        summary.push("No video could be delivered.");
      } else {
        summary.push(`${delivered.length} of ${result.videos.length} video(s) delivered (${delivery}). Content block indexes below count from the first block of this result.`);
      }
      // Block 0 is this summary; media blocks start at 1, so shift the indexes we report.
      for (const video of result.videos) {
        const shifted: DeliveredVideo = {
          ...video,
          delivered: { ...video.delivered, block_indexes: video.delivered.block_indexes.map((i) => i + 1) },
        };
        summary.push(`• ${describeDelivered(shifted)}`);
      }
      if (allWarnings.length > 0) summary.push(...allWarnings.map((w) => `⚠ ${w}`));

      const metadata = {
        delivery,
        creative_id: resolved.creative_id,
        account_id: resolved.account_id,
        videos: result.videos.map((video) => ({
          ...video,
          delivered: { ...video.delivered, block_indexes: video.delivered.block_indexes.map((i) => i + 1) },
        })),
        total_media_bytes: result.bytes,
        warnings: allWarnings,
      };

      const content: CallToolResult["content"] = [
        textBlock(summary.join("\n")),
        ...result.blocks,
        textBlock(JSON.stringify(metadata, null, 2)),
      ];
      const isError = resolved.sources.length > 0 && delivered.length === 0;
      return isError ? { content, isError: true } : { content };
    },
  );
}
