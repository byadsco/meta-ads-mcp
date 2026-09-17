import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import { IMAGE_DEFAULT_FIELDS } from "../meta/types/image.js";
import { VIDEO_DETAIL_FIELDS } from "../meta/types/video.js";
import type { AdCreative, AdImage, AdVideo, MetaApiResponse } from "../meta/types/index.js";
import { downloadSafePublicImage } from "../utils/safe-download.js";
import { logger } from "../utils/logger.js";
import { resolveTenantId } from "../auth/tenant.js";
import { safeHostname, sanitizeMetadataUrl, textBlock, type ContentBlock } from "../media/content-blocks.js";
import {
  deliverVideos as defaultDeliverVideos,
  DEFAULT_VIDEO_TOTAL_BYTES_BUDGET,
  VIDEO_EXPIRY_WARNING,
  type DeliveredVideo,
  type VideoDeliveryDeps,
} from "../media/video-delivery.js";
import type { VideoSource } from "../media/video-sources.js";
import { asRecord, getString } from "./creatives.js";
import { READ } from "./_register.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES_BUDGET = 20 * 1024 * 1024;
const MISSING_ACCOUNT_HINT =
  "Image hash could not be resolved to a URL — pass account_id so the adimages lookup can run.";

export type MediaRole =
  | "primary"
  | "carousel_child"
  | "asset_feed_image"
  | "video_thumbnail"
  | "thumbnail_fallback";

export interface ImageRef {
  role: MediaRole;
  url?: string;
  hash?: string;
  carouselIndex?: number;
}

export interface VideoRef {
  videoId: string;
  specThumbnailUrl?: string;
  specThumbnailHash?: string;
}

interface ImageAssetMeta {
  block_index?: number;
  role: MediaRole;
  carousel_index?: number;
  image_hash?: string;
  width?: number;
  height?: number;
  permalink_url?: string;
  source_url?: string;
  mime_type?: string;
  bytes?: number;
  downloaded: boolean;
  error?: string;
  skipped?: "max_images" | "size_budget";
}

interface VideoAssetMeta {
  video_id: string;
  title?: string;
  length_seconds?: number;
  source_url?: string;
  thumbnail_url?: string;
  permalink_url?: string;
  thumbnail_block_index?: number;
  download_hint?: string;
  delivered?: DeliveredVideo["delivered"];
  error?: string;
}

export function collectCreativeMedia(creative: AdCreative): { images: ImageRef[]; videos: VideoRef[] } {
  const images: ImageRef[] = [];
  const videos: VideoRef[] = [];
  const imagesByKey = new Map<string, ImageRef>();
  const seenVideos = new Set<string>();

  const addImage = (ref: ImageRef): void => {
    const keys = [ref.hash, ref.url].filter((key): key is string => Boolean(key));
    if (keys.length === 0) return;
    // A ref carrying both identifiers can connect two previously separate
    // entries (one hash-only, one url-only) — merge them into one asset so the
    // same image is never downloaded twice.
    const existingRefs = [...new Set(keys.map((key) => imagesByKey.get(key)).filter((r): r is ImageRef => Boolean(r)))];
    if (existingRefs.length > 0) {
      const target = existingRefs[0];
      for (const other of existingRefs.slice(1)) {
        target.hash ??= other.hash;
        target.url ??= other.url;
        const index = images.indexOf(other);
        if (index >= 0) images.splice(index, 1);
        for (const [key, value] of imagesByKey) {
          if (value === other) imagesByKey.set(key, target);
        }
      }
      target.hash ??= ref.hash;
      target.url ??= ref.url;
      for (const key of keys) imagesByKey.set(key, target);
      return;
    }
    images.push(ref);
    for (const key of keys) imagesByKey.set(key, ref);
  };
  const addVideo = (ref: VideoRef): void => {
    if (seenVideos.has(ref.videoId)) return;
    seenVideos.add(ref.videoId);
    videos.push(ref);
  };

  addImage({ role: "primary", url: creative.image_url, hash: creative.image_hash });

  const objectStorySpec = asRecord(creative.object_story_spec);
  const linkData = asRecord(objectStorySpec?.["link_data"]);
  if (linkData) {
    addImage({
      role: "primary",
      hash: getString(linkData, "image_hash"),
      url: getString(linkData, "picture"),
    });
    const children = Array.isArray(linkData["child_attachments"]) ? linkData["child_attachments"] : [];
    children.forEach((child, index) => {
      const record = asRecord(child);
      if (!record) return;
      const videoId = getString(record, "video_id");
      if (videoId) {
        addVideo({
          videoId,
          specThumbnailUrl: getString(record, "picture"),
          specThumbnailHash: getString(record, "image_hash"),
        });
        return;
      }
      addImage({
        role: "carousel_child",
        carouselIndex: index,
        hash: getString(record, "image_hash"),
        url: getString(record, "picture"),
      });
    });
  }

  const videoData = asRecord(objectStorySpec?.["video_data"]);
  const videoId = getString(videoData, "video_id");
  if (videoId) {
    addVideo({
      videoId,
      specThumbnailUrl: getString(videoData, "image_url"),
      specThumbnailHash: getString(videoData, "image_hash"),
    });
  }

  const assetFeedSpec = asRecord(creative.asset_feed_spec);
  const feedImages = Array.isArray(assetFeedSpec?.["images"]) ? assetFeedSpec["images"] : [];
  for (const entry of feedImages) {
    const record = asRecord(entry);
    if (!record) continue;
    addImage({
      role: "asset_feed_image",
      hash: getString(record, "hash"),
      url: getString(record, "url"),
    });
  }
  const feedVideos = Array.isArray(assetFeedSpec?.["videos"]) ? assetFeedSpec["videos"] : [];
  for (const entry of feedVideos) {
    const record = asRecord(entry);
    const feedVideoId = getString(record, "video_id");
    if (!feedVideoId) continue;
    addVideo({
      videoId: feedVideoId,
      specThumbnailUrl: getString(record, "thumbnail_url"),
      specThumbnailHash: getString(record, "thumbnail_hash"),
    });
  }

  if (images.length === 0 && videos.length === 0 && creative.thumbnail_url) {
    addImage({ role: "thumbnail_fallback", url: creative.thumbnail_url });
  }

  return { images, videos };
}

export function pickVideoThumbnailUrl(video: AdVideo, size: "full" | "small"): string | undefined {
  const thumbs = video.thumbnails?.data ?? [];
  const largest = thumbs.length > 0
    ? [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
    : undefined;
  return size === "small" ? video.picture ?? largest?.uri : largest?.uri ?? video.picture;
}

async function resolveImageHashes(accountId: string, hashes: string[]): Promise<Map<string, AdImage>> {
  const response = await metaApiClient.get<MetaApiResponse<AdImage>>(
    `/${accountId}/adimages`,
    {
      fields: IMAGE_DEFAULT_FIELDS.join(","),
      hashes: JSON.stringify(hashes),
    },
  );
  return new Map((response.data ?? []).map((img) => [img.hash, img]));
}

export interface CreativeMediaDeps extends VideoDeliveryDeps {
  download?: typeof downloadSafePublicImage;
  deliverVideos?: typeof defaultDeliverVideos;
}

export function registerCreativeMediaTools(server: McpServer, deps: CreativeMediaDeps = {}): void {
  const download = deps.download ?? downloadSafePublicImage;
  const deliverVideos = deps.deliverVideos ?? defaultDeliverVideos;

  server.registerTool(
    "ads_get_creative_media",
    {
      description:
        "Download the actual creative media for an ad or creative and return the images inline for visual analysis. Images (including carousel cards and video thumbnails) come back as image content blocks a multimodal model can see directly. Videos: video_delivery=thumbnail (default) returns the poster frame plus a short-lived signed source URL in the JSON metadata; video_delivery=frames additionally extracts real keyframes with ffmpeg as image blocks so any multimodal model can analyze the video; video_delivery=url returns resource_link blocks. For the MP4 itself (video-capable models such as Gemini) use ads_get_video_media with delivery=inline.",
      inputSchema: {
        ad_id: z.string().optional().describe("Ad ID — its creative is resolved automatically"),
        creative_id: z.string().optional().describe("Creative ID (alternative to ad_id)"),
        account_id: z
          .string()
          .optional()
          .describe("Ad account ID (act_… or numeric). Only needed as a fallback when the creative references image hashes and the account cannot be derived from the ad/creative"),
        image_size: z
          .enum(["full", "small"])
          .default("full")
          .describe("full = original CDN image; small = 128px preview (url_128) when available — cheaper on context"),
        max_images: z
          .number()
          .min(1)
          .max(10)
          .default(5)
          .describe("Cap on returned image blocks (bounds response/context size)"),
        include_videos: z
          .boolean()
          .default(true)
          .describe("Also resolve videos: returns each video's thumbnail as an image block plus its signed source URL in the JSON metadata"),
        video_delivery: z
          .enum(["thumbnail", "frames", "url"])
          .default("thumbnail")
          .describe("thumbnail = poster image only (default); frames = also extract keyframes with ffmpeg (grid contact sheet); url = also return signed CDN links as resource_link blocks"),
        frame_count: z.number().int().min(1).max(12).default(6).describe("Frames per video when video_delivery=frames"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, creative_id, account_id, image_size = "full", max_images = 5, include_videos = true, video_delivery = "thumbnail", frame_count = 6 }, extra) => {
      if (!ad_id && !creative_id) {
        throw new Error("Either ad_id or creative_id is required.");
      }
      if (ad_id && creative_id) {
        throw new Error("Provide either ad_id or creative_id, not both.");
      }

      let resolvedAccountId = account_id ? normalizeAccountId(account_id) : undefined;
      let creativeId = creative_id;

      if (ad_id) {
        const adId = validateMetaId(ad_id, "ad");
        const ad = await metaApiClient.get<{ id: string; account_id?: string; creative?: { id: string } }>(
          `/${adId}`,
          { fields: "id,account_id,creative{id}" },
        );
        if (!ad.creative?.id) {
          throw new Error(`Ad ${adId} has no creative attached.`);
        }
        creativeId = ad.creative.id;
        if (!resolvedAccountId && ad.account_id) {
          resolvedAccountId = normalizeAccountId(ad.account_id);
        }
      }

      const id = validateMetaId(creativeId as string, "creative");
      // thumbnail_width/height make Graph return an upsized thumbnail_url, so the
      // boosted-post fallback yields an analyzable image instead of a 64px one.
      const creative = await metaApiClient.get<AdCreative>(`/${id}`, {
        fields: [...CREATIVE_DEFAULT_FIELDS, "account_id"].join(","),
        thumbnail_width: 1080,
        thumbnail_height: 1080,
      });
      if (!resolvedAccountId && creative.account_id) {
        resolvedAccountId = normalizeAccountId(creative.account_id);
      }

      const { images, videos } = collectCreativeMedia(creative);
      const warnings: string[] = [];

      // In "small" mode a hash is worth resolving even when the spec already
      // carries a full-size URL — the adimages lookup is what provides url_128.
      const wantSmall = image_size === "small";
      const hashesToResolve = new Set<string>();
      for (const ref of images) {
        if (ref.hash && (!ref.url || wantSmall)) hashesToResolve.add(ref.hash);
      }
      for (const ref of videos) {
        if (ref.specThumbnailHash && (!ref.specThumbnailUrl || wantSmall)) hashesToResolve.add(ref.specThumbnailHash);
      }

      let hashMap = new Map<string, AdImage>();
      if (hashesToResolve.size > 0) {
        if (resolvedAccountId) {
          try {
            hashMap = await resolveImageHashes(resolvedAccountId, [...hashesToResolve]);
          } catch (err) {
            warnings.push(`Image hash lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const blockedByMissingAccount =
            images.some((ref) => ref.hash && !ref.url)
            || videos.some((ref) => ref.specThumbnailHash && !ref.specThumbnailUrl);
          if (blockedByMissingAccount) warnings.push(MISSING_ACCOUNT_HINT);
        }
      }

      const resolvedHashUrl = (hash?: string): string | undefined => {
        if (!hash) return undefined;
        const resolved = hashMap.get(hash);
        return wantSmall ? resolved?.url_128 ?? resolved?.url : resolved?.url;
      };

      const imageAssets: ImageAssetMeta[] = images.map((ref) => {
        const resolved = ref.hash ? hashMap.get(ref.hash) : undefined;
        const fullUrl = resolved?.url ?? ref.url;
        const sourceUrl = image_size === "small" ? resolved?.url_128 ?? fullUrl : fullUrl;
        return {
          role: ref.role,
          carousel_index: ref.carouselIndex,
          image_hash: ref.hash,
          width: resolved?.width,
          height: resolved?.height,
          permalink_url: resolved?.permalink_url,
          source_url: sourceUrl,
          downloaded: false,
          error: sourceUrl ? undefined : (resolvedAccountId ? "No downloadable URL found for this image." : MISSING_ACCOUNT_HINT),
        };
      });

      const videoAssets: VideoAssetMeta[] = [];
      const videoThumbAssets = new Map<string, ImageAssetMeta>();
      if (include_videos) {
        for (const ref of videos) {
          try {
            const video = await metaApiClient.get<AdVideo>(
              `/${validateMetaId(ref.videoId, "video")}`,
              { fields: VIDEO_DETAIL_FIELDS.join(",") },
            );
            const thumbnailUrl = pickVideoThumbnailUrl(video, image_size)
              ?? (wantSmall ? resolvedHashUrl(ref.specThumbnailHash) ?? ref.specThumbnailUrl : ref.specThumbnailUrl ?? resolvedHashUrl(ref.specThumbnailHash));
            if (thumbnailUrl) {
              const thumbAsset: ImageAssetMeta = {
                role: "video_thumbnail",
                source_url: thumbnailUrl,
                downloaded: false,
              };
              imageAssets.push(thumbAsset);
              videoThumbAssets.set(video.id, thumbAsset);
            }
            videoAssets.push({
              video_id: video.id,
              title: video.title,
              length_seconds: video.length,
              source_url: video.source,
              thumbnail_url: thumbnailUrl,
              permalink_url: video.permalink_url,
              download_hint: video.source
                ? `Download with: curl -L -o video_${video.id}.mp4 "<source_url>" — or pass the URL directly to a video-capable model (e.g. Gemini).`
                : undefined,
              error: video.source ? undefined : "Video source URL not available (still processing, or missing permission).",
            });
          } catch (err) {
            const fallbackThumb = wantSmall
              ? resolvedHashUrl(ref.specThumbnailHash) ?? ref.specThumbnailUrl
              : ref.specThumbnailUrl ?? resolvedHashUrl(ref.specThumbnailHash);
            if (fallbackThumb) {
              const thumbAsset: ImageAssetMeta = {
                role: "video_thumbnail",
                source_url: fallbackThumb,
                downloaded: false,
              };
              imageAssets.push(thumbAsset);
              videoThumbAssets.set(ref.videoId, thumbAsset);
            }
            videoAssets.push({
              video_id: ref.videoId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      let totalBytes = 0;
      let blockIndex = 0;
      const imageBlocks: ContentBlock[] = [];
      for (const asset of imageAssets) {
        if (!asset.source_url) continue;
        if (imageBlocks.length >= max_images) {
          asset.skipped = "max_images";
          continue;
        }
        const remainingBudget = TOTAL_BYTES_BUDGET - totalBytes;
        if (remainingBudget <= 0) {
          asset.skipped = "size_budget";
          continue;
        }
        try {
          const downloaded = await download(asset.source_url, {
            maxBytes: Math.min(MAX_IMAGE_BYTES, remainingBudget),
          });
          totalBytes += downloaded.buffer.length;
          imageBlocks.push({
            type: "image",
            data: downloaded.buffer.toString("base64"),
            mimeType: downloaded.contentType,
          });
          asset.downloaded = true;
          asset.block_index = blockIndex;
          asset.mime_type = downloaded.contentType;
          asset.bytes = downloaded.buffer.length;
          blockIndex += 1;
        } catch (err) {
          asset.error = err instanceof Error ? err.message : String(err);
          logger.warn(
            { imageHost: safeHostname(asset.source_url), role: asset.role },
            "Creative media download failed",
          );
        }
      }

      for (const video of videoAssets) {
        const thumbAsset = videoThumbAssets.get(video.video_id);
        if (thumbAsset?.downloaded) video.thumbnail_block_index = thumbAsset.block_index;
      }

      const videoBlocks: ContentBlock[] = [];
      const deliverySummary: string[] = [];
      if (video_delivery !== "thumbnail" && videoAssets.some((v) => v.source_url)) {
        const sources: VideoSource[] = videoAssets
          .filter((v) => v.source_url)
          .map((v) => ({
            key: `meta:video:${v.video_id}`,
            label: `Video ${v.video_id}`,
            origin: "meta",
            video_id: v.video_id,
            source_url: v.source_url,
            // The poster is already attached above; the pipeline must not fetch it twice.
            thumbnail_url: undefined,
            duration_seconds: v.length_seconds,
            permalink_url: v.permalink_url,
            title: v.title,
          }));
        // Images already attached count against the same response budget as the video media.
        const remainingBudget = Math.max(0, DEFAULT_VIDEO_TOTAL_BYTES_BUDGET - totalBytes);
        const delivery = await deliverVideos(
          sources,
          { delivery: video_delivery, frame_count, frame_layout: "grid" },
          deps,
          { tenantId: resolveTenantId({ feature: "video" }), signal: extra?.signal },
          { totalBytesBudget: remainingBudget },
        );
        // Video blocks are appended after the image blocks (and after the summary text at index 0).
        const offset = imageBlocks.length + 1;
        videoBlocks.push(...delivery.blocks);
        for (const delivered of delivery.videos) {
          const asset = videoAssets.find((v) => v.video_id === delivered.video_id);
          if (!asset) continue;
          asset.delivered = {
            ...delivered.delivered,
            block_indexes: delivered.delivered.block_indexes.map((i) => i + offset),
          };
          if (delivered.error && !asset.error) asset.error = delivered.error;
          if (delivered.delivered.mode === "frames") {
            const ts = (delivered.delivered.frame_timestamps ?? []).map((t) => `${t.toFixed(1)}s`).join(", ");
            deliverySummary.push(`Video ${asset.video_id}: keyframes attached as block(s) ${asset.delivered.block_indexes.join(", ")} (contact sheet, read left-to-right, top-to-bottom; sampled at ${ts}).`);
          } else if (delivered.delivered.mode === "url") {
            deliverySummary.push(`Video ${asset.video_id}: signed URL(s) attached as resource_link block(s) ${asset.delivered.block_indexes.join(", ")}.`);
          } else if (delivered.error) {
            deliverySummary.push(`Video ${asset.video_id}: ${delivered.error}`);
          }
        }
        warnings.push(...delivery.warnings.filter((w) => w !== VIDEO_EXPIRY_WARNING));
      }

      if (videoAssets.some((v) => v.source_url)) {
        warnings.push(VIDEO_EXPIRY_WARNING);
      }

      const downloadedCount = imageAssets.filter((a) => a.downloaded).length;
      const failedCount = imageAssets.filter((a) => !a.downloaded && a.error).length;
      const skippedCount = imageAssets.filter((a) => a.skipped).length;

      const summaryLines: string[] = [];
      if (downloadedCount === 0 && videoAssets.length === 0) {
        summaryLines.push(`No downloadable media found for creative ${creative.id}.`);
      } else {
        summaryLines.push(
          `Creative ${creative.id} (${creative.name ?? "Unnamed"}): ${downloadedCount} image(s) attached below${failedCount ? `, ${failedCount} failed` : ""}${skippedCount ? `, ${skippedCount} skipped (limits)` : ""}.`,
        );
        const roles = imageAssets
          .filter((a) => a.downloaded)
          .map((a) => a.role + (a.carousel_index !== undefined ? `#${a.carousel_index}` : ""));
        if (roles.length > 0) summaryLines.push(`Image roles, in block order: ${roles.join(", ")}.`);
        for (const video of videoAssets) {
          summaryLines.push(
            video.source_url
              ? `Video ${video.video_id}${video.length_seconds ? ` (${video.length_seconds}s)` : ""}: ${video_delivery === "thumbnail" ? "thumbnail attached; " : ""}signed source_url in the JSON metadata (curl -L -o video_${video.video_id}.mp4 "<source_url>"), or call ads_get_video_media (delivery=frames for keyframes, delivery=inline to embed the MP4 for a video-capable model).`
              : `Video ${video.video_id}: ${video.error ?? "no source URL available"}.`,
          );
        }
        summaryLines.push(...deliverySummary);
      }
      if (warnings.length > 0) {
        summaryLines.push(...warnings.map((w) => `⚠ ${w}`));
      }

      const metadata = {
        creative_id: creative.id,
        ad_id: ad_id ?? undefined,
        account_id: resolvedAccountId,
        images: imageAssets.map((asset) => ({
          ...asset,
          source_url: sanitizeMetadataUrl(asset.source_url),
          permalink_url: sanitizeMetadataUrl(asset.permalink_url),
        })),
        videos: videoAssets.map((video) => ({
          ...video,
          source_url: sanitizeMetadataUrl(video.source_url),
          thumbnail_url: sanitizeMetadataUrl(video.thumbnail_url),
          permalink_url: sanitizeMetadataUrl(video.permalink_url),
        })),
        video_delivery,
        warnings,
      };

      return {
        content: [
          textBlock(summaryLines.join("\n")),
          ...imageBlocks,
          ...videoBlocks,
          textBlock(JSON.stringify(metadata, null, 2)),
        ],
      };
    },
  );
}
