import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import { IMAGE_DEFAULT_FIELDS } from "../meta/types/image.js";
import { VIDEO_DEFAULT_FIELDS, VIDEO_DETAIL_FIELDS } from "../meta/types/video.js";
import type { AdCreative, AdImage, AdVideo, MetaApiResponse } from "../meta/types/index.js";
import { logger } from "../utils/logger.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import { downloadSafePublicImage } from "../utils/safe-download.js";

const ctaEnum = z.enum([
  // Core actions
  "LEARN_MORE", "SIGN_UP", "DOWNLOAD", "SUBSCRIBE", "CONTACT_US",
  "APPLY_NOW", "GET_OFFER", "GET_QUOTE", "GET_STARTED", "OPEN_LINK",
  "NO_BUTTON", "SEE_MORE",
  // Shopping & commerce
  "SHOP_NOW", "BUY_NOW", "ORDER_NOW", "START_ORDER", "ADD_TO_CART",
  "VIEW_PRODUCT", "BUY_VIA_MESSAGE", "GET_PROMOTIONS",
  // Booking & services
  "BOOK_NOW", "BOOK_TRAVEL", "MAKE_AN_APPOINTMENT", "BOOK_A_CONSULTATION",
  "ASK_ABOUT_SERVICES", "GET_A_QUOTE", "REQUEST_TIME",
  // Communication
  "SEND_MESSAGE", "MESSAGE_PAGE", "WHATSAPP_MESSAGE", "CHAT_WITH_US",
  "CALL_NOW", "GET_IN_TOUCH",
  // Media & entertainment
  "WATCH_MORE", "WATCH_VIDEO", "LISTEN_NOW",
  // App
  "INSTALL_APP", "USE_APP",
  // Page & social
  "LIKE_PAGE", "FOLLOW_PAGE", "EVENT_RSVP", "DONATE_NOW",
  // Local
  "GET_DIRECTIONS",
  // AI features (v25.0)
  "SHOP_WITH_AI", "TRY_ON_WITH_AI",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedString(record: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function extractEffectiveLinkUrl(creative: AdCreative): string | undefined {
  if (creative.link_url) return creative.link_url;

  const objectStorySpec = asRecord(creative.object_story_spec);
  const videoData = asRecord(objectStorySpec?.["video_data"]);
  const linkData = asRecord(objectStorySpec?.["link_data"]);
  const assetFeedSpec = asRecord(creative.asset_feed_spec);

  return (
    getNestedString(videoData, ["call_to_action", "value", "link"])
    ?? getString(linkData, "link")
    ?? getNestedString(linkData, ["call_to_action", "value", "link"])
    ?? getNestedString(assetFeedSpec, ["link_urls", "0", "website_url"])
  );
}

export function registerCreativeTools(server: McpServer): void {
  // ─── Get Ad Creatives ────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_creatives",
    "Get creative details for an ad or list creatives for an ad account.",
    {
      ad_id: z.string().optional().describe("Ad ID to get creatives for"),
      account_id: z.string().optional().describe("Account ID to list all creatives"),
      limit: z.number().min(1).max(100).default(25),
    },
    async ({ ad_id, account_id, limit }) => {
      const fieldsParam = buildFieldsParam(undefined, [...CREATIVE_DEFAULT_FIELDS]);

      let path: string;
      if (ad_id) {
        path = `/${validateMetaId(ad_id, "ad")}/adcreatives`;
      } else if (account_id) {
        path = `/${normalizeAccountId(account_id)}/adcreatives`;
      } else {
        throw new Error("Either ad_id or account_id is required.");
      }

      const response = await metaApiClient.get<MetaApiResponse<AdCreative>>(
        path,
        { fields: fieldsParam, limit },
      );
      const creatives = response.data ?? [];

      const text =
        creatives.length === 0
          ? "No creatives found."
          : creatives
              .map(
                (c) =>
                  `• ${c.name ?? "Unnamed"} (${c.id}) — CTA: ${c.call_to_action_type ?? "N/A"} — Image: ${c.image_url ? "Yes" : "No"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${creatives.length} creative(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(creatives, null, 2) },
        ],
      };
    },
  );

  // ─── Get Creative Details ────────────────────────────────────
  server.tool(
    "meta_ads_get_creative_details",
    "Get detailed information about a specific creative.",
    {
      creative_id: z.string().describe("Creative ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ creative_id, fields }) => {
      const id = validateMetaId(creative_id, "creative");
      const fieldsParam = buildFieldsParam(fields, [...CREATIVE_DEFAULT_FIELDS]);
      const creative = await metaApiClient.get<AdCreative>(`/${id}`, {
        fields: fieldsParam,
      });
      const effectiveLinkUrl = extractEffectiveLinkUrl(creative);
      const responseCreative =
        effectiveLinkUrl && !creative.effective_link_url
          ? { ...creative, effective_link_url: effectiveLinkUrl }
          : creative;

      const lines: string[] = [
        `Creative: ${creative.name ?? "Unnamed"} (${creative.id})`,
        `Status: ${creative.status ?? "N/A"}`,
        `CTA: ${creative.call_to_action_type ?? "N/A"}`,
        `Link URL: ${effectiveLinkUrl ?? "N/A"}`,
        `Post ID: ${creative.effective_object_story_id ?? "N/A"}`,
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(responseCreative, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Creative ──────────────────────────────────────
  server.tool(
    "meta_ads_create_ad_creative",
    "Create a new ad creative. Three modes: (1) Build from scratch with image/video + text via object_story_spec, (2) Promote an existing Facebook Page post via object_story_id ('Boost Post'), (3) Promote an existing Instagram post via source_instagram_media_id. The creative can then be used when creating ads. Important: scratch-built video creatives require a thumbnail via image_hash or image_url; Meta rejects video_id without one.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Creative name"),
      page_id: z.string().optional().describe("Facebook Page ID (required for object_story_spec mode, not needed for object_story_id or source_instagram_media_id)"),
      object_story_id: z.string().optional().describe("Existing Facebook Page post ID to promote as an ad ('Boost Post' flow). Format: {page_id}_{post_id}. When provided, object_story_spec is NOT built — the existing post is used as-is."),
      instagram_actor_id: z.string().optional().describe("Instagram account ID (from get_instagram_account). Required when promoting IG posts."),
      source_instagram_media_id: z.string().optional().describe("Instagram media ID to create a creative from an existing IG post (from get_instagram_media). When provided, image_hash/image_url/video_id are ignored."),
      image_hash: z.string().optional().describe("Image hash from upload_ad_image"),
      image_url: z.string().optional().describe("Image URL (alternative to image_hash)"),
      video_id: z.string().optional().describe("Video ID"),
      link_url: z.string().optional().describe("Destination URL"),
      message: z.string().optional().describe("Primary text / body copy"),
      headline: z.string().optional().describe("Headline text"),
      description: z.string().optional().describe("Description text (shown below headline)"),
      call_to_action_type: ctaEnum.optional().describe("Call-to-action button type"),
      url_tags: z.string().optional().describe("Query string params appended to URLs clicked from the ad (e.g. 'utm_source=meta&utm_medium=paid')"),
    },
    async ({
      account_id, name, page_id, object_story_id, instagram_actor_id, source_instagram_media_id,
      image_hash, image_url, video_id, link_url, message, headline, description,
      call_to_action_type, url_tags,
    }) => {
      const accountPath = normalizeAccountId(account_id);
      const pageIdValidated = page_id ? validateMetaId(page_id, "page") : undefined;
      const objectStoryIdValidated = object_story_id
        ? validateMetaId(object_story_id, "post")
        : undefined;
      const instagramActorIdValidated = instagram_actor_id
        ? validateMetaId(instagram_actor_id, "instagram_actor")
        : undefined;
      const sourceInstagramMediaIdValidated = source_instagram_media_id
        ? validateMetaId(source_instagram_media_id, "instagram_media")
        : undefined;
      const videoIdValidated = video_id
        ? validateMetaId(video_id, "video")
        : undefined;

      const body: Record<string, string | number | boolean> = { name };

      if (sourceInstagramMediaIdValidated) {
        // Mode 3: Promote an existing Instagram post — NO object_story_spec
        // Docs: https://developers.facebook.com/docs/instagram/ads-api/guides/use-posts-as-ads
        body.source_instagram_media_id = sourceInstagramMediaIdValidated;
        if (pageIdValidated) body.object_id = pageIdValidated;
        if (instagramActorIdValidated) body.instagram_user_id = instagramActorIdValidated;
        if (call_to_action_type) {
          body.call_to_action = JSON.stringify({
            type: call_to_action_type,
            value: link_url ? { link: link_url } : undefined,
          });
        }
      } else if (objectStoryIdValidated) {
        // Mode 2: Boost an existing Facebook Page post — NO object_story_spec
        body.object_story_id = objectStoryIdValidated;
        if (instagramActorIdValidated) body.instagram_user_id = instagramActorIdValidated;
      } else {
        // Mode 1: Build creative from scratch with object_story_spec
        if (!pageIdValidated) {
          throw new Error("page_id is required when building a creative from scratch (no object_story_id or source_instagram_media_id provided).");
        }
        if (videoIdValidated && !image_hash && !image_url) {
          throw new Error("video creatives built from scratch require image_hash or image_url as a thumbnail.");
        }
        // SSRF guard: only validate image_url when it will actually be
        // forwarded to Meta — i.e. Mode 1 with no image_hash override. Other
        // modes ignore image_url entirely, so a stale value shouldn't fail
        // the call.
        if (image_url && !image_hash) {
          try {
            await assertSafePublicUrl(image_url);
          } catch (err) {
            if (err instanceof UnsafeUrlError) {
              throw new Error(`Refusing to forward image_url to Meta: ${err.message}`);
            }
            throw err;
          }
        }
        const objectStorySpec: Record<string, unknown> = { page_id: pageIdValidated };

        if (videoIdValidated) {
          // Video creative — link goes inside CTA, not as top-level field
          const videoData: Record<string, unknown> = { video_id: videoIdValidated };
          if (message) videoData.message = message;
          if (image_hash) videoData.image_hash = image_hash;
          if (image_url && !image_hash) videoData.image_url = image_url;
          if (headline) videoData.title = headline;
          if (call_to_action_type || link_url) {
            videoData.call_to_action = {
              type: call_to_action_type ?? "LEARN_MORE",
              value: link_url ? { link: link_url } : undefined,
            };
          }
          objectStorySpec.video_data = videoData;
        } else {
          // Image/link creative — standard link_data structure
          const linkData: Record<string, unknown> = {};
          if (image_hash) linkData.image_hash = image_hash;
          if (image_url && !image_hash) linkData.picture = image_url;
          if (link_url) linkData.link = link_url;
          if (message) linkData.message = message;
          if (headline) linkData.name = headline;
          if (description) linkData.description = description;
          if (call_to_action_type) {
            linkData.call_to_action = {
              type: call_to_action_type,
              value: link_url ? { link: link_url } : undefined,
            };
          }
          objectStorySpec.link_data = linkData;
        }

        if (instagramActorIdValidated) {
          objectStorySpec.instagram_actor_id = instagramActorIdValidated;
        }

        body.object_story_spec = JSON.stringify(objectStorySpec);
      }

      if (url_tags) body.url_tags = url_tags;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${accountPath}/adcreatives`,
        body,
      );

      // Fetch effective_object_story_id so the user immediately knows the post ID
      let effectiveStoryId: string | undefined;
      try {
        const created = await metaApiClient.get<{ id: string; effective_object_story_id?: string }>(
          `/${validateMetaId(result.id, "creative")}`,
          { fields: "id,effective_object_story_id" },
        );
        effectiveStoryId = created.effective_object_story_id;
      } catch {
        // Non-critical — continue without it
      }

      return {
        content: [
          {
            type: "text",
            text: `Creative created successfully!\nID: ${result.id}\nName: ${name}${pageIdValidated ? `\nPage: ${pageIdValidated}` : ""}${objectStoryIdValidated ? `\nBoosted Post: ${objectStoryIdValidated}` : ""}${sourceInstagramMediaIdValidated ? `\nIG Post: ${sourceInstagramMediaIdValidated}` : ""}${effectiveStoryId ? `\nPost ID: ${effectiveStoryId}` : ""}\nCTA: ${call_to_action_type ?? "N/A"}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad Creative ──────────────────────────────────────
  server.tool(
    "meta_ads_update_ad_creative",
    "Update an existing creative's name. Note: most creative fields are immutable after creation.",
    {
      creative_id: z.string().describe("Creative ID to update"),
      name: z.string().optional().describe("New name for the creative"),
    },
    async ({ creative_id, name }) => {
      const id = validateMetaId(creative_id, "creative");
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      return {
        content: [
          { type: "text", text: `Creative ${id} updated successfully.` },
        ],
      };
    },
  );

  // ─── Upload Ad Image ─────────────────────────────────────────
  server.tool(
    "meta_ads_upload_ad_image",
    "Upload an image to Meta for use in ad creatives. Provide an image URL — the server will download and upload it to Meta. Returns an image hash for use in create_ad_creative.",
    {
      account_id: z.string().describe("Ad account ID"),
      image_url: z.string().describe("URL of the image to upload"),
      name: z.string().optional().describe("Optional name for the image"),
    },
    async ({ account_id, image_url, name }) => {
      const id = normalizeAccountId(account_id);

      try {
        const downloaded = await downloadSafePublicImage(image_url);
        logger.info(
          { imageHost: downloaded.finalUrl.hostname, bytes: downloaded.buffer.length },
          "Downloaded image for upload",
        );

        const formData = new FormData();
        const imageBytes = new Uint8Array(downloaded.buffer.length);
        imageBytes.set(downloaded.buffer);
        formData.set(
          "filename",
          new Blob([imageBytes], { type: downloaded.contentType }),
          `image${downloaded.extension}`,
        );
        if (name) formData.set("name", name);

        const result = await metaApiClient.postMultipart<{ images: Record<string, { hash: string; url: string; name?: string }> }>(
          `/${id}/adimages`,
          formData,
        );

        const imageEntries = Object.values(result.images ?? {});
        const uploaded = imageEntries[0];

        if (!uploaded) {
          throw new Error("Image upload failed — no image hash returned.");
        }

        return {
          content: [
            {
              type: "text",
              text: `Image uploaded successfully!\nHash: ${uploaded.hash}\nURL: ${uploaded.url}\nName: ${uploaded.name ?? name ?? "N/A"}\n\nUse the hash "${uploaded.hash}" when creating a creative with create_ad_creative.`,
            },
          ],
        };
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          throw new Error(`Refusing to download image_url: ${err.message}`);
        }
        throw err;
      }
    },
  );

  // ─── Get Ad Images ────────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_images",
    "List images uploaded to an ad account with their full URLs. Useful for previewing creative assets without opening Ads Manager.",
    {
      account_id: z.string().describe("Ad account ID"),
      hashes: z.array(z.string()).optional().describe("Filter by specific image hashes"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, hashes, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...IMAGE_DEFAULT_FIELDS]);

      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (hashes && hashes.length > 0) {
        params.hashes = JSON.stringify(hashes);
      }

      const response = await metaApiClient.get<MetaApiResponse<AdImage>>(
        `/${id}/adimages`,
        params,
      );
      const images = response.data ?? [];

      const text =
        images.length === 0
          ? "No images found."
          : images
              .map(
                (img) =>
                  `• ${img.name ?? "Unnamed"} — Hash: ${img.hash}\n  URL: ${img.url}\n  Size: ${img.width ?? "?"}x${img.height ?? "?"}`,
              )
              .join("\n\n");

      return {
        content: [
          { type: "text", text: `Found ${images.length} image(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(images, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Videos ────────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_videos",
    "List videos uploaded to an ad account with source URLs and thumbnails. Use this to preview video creatives directly.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...VIDEO_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<AdVideo>>(
        `/${id}/advideos`,
        { fields: fieldsParam, limit },
      );
      const videos = response.data ?? [];

      const text =
        videos.length === 0
          ? "No videos found."
          : videos
              .map(
                (v) =>
                  `• ${v.title ?? "Untitled"} (${v.id}) — Duration: ${v.length ? `${v.length}s` : "N/A"}\n  Source: ${v.source ?? "N/A"}\n  Thumbnail: ${v.picture ?? "N/A"}`,
              )
              .join("\n\n");

      return {
        content: [
          { type: "text", text: `Found ${videos.length} video(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(videos, null, 2) },
        ],
      };
    },
  );

  // ─── Get Video Details ────────────────────────────────────────
  server.tool(
    "meta_ads_get_video_details",
    "Get detailed information about a specific video including source URL, thumbnails at different sizes, and processing status.",
    {
      video_id: z.string().describe("Video ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ video_id, fields }) => {
      const id = validateMetaId(video_id, "video");
      const fieldsParam = buildFieldsParam(fields, [...VIDEO_DETAIL_FIELDS]);

      const video = await metaApiClient.get<AdVideo>(
        `/${id}`,
        { fields: fieldsParam },
      );

      const lines: string[] = [
        `Video: ${video.title ?? "Untitled"} (${video.id})`,
        `Duration: ${video.length ? `${video.length}s` : "N/A"}`,
        `Status: ${video.status?.video_status ?? "N/A"}`,
        `Source URL: ${video.source ?? "Not available"}`,
        `Thumbnail: ${video.picture ?? "Not available"}`,
      ];

      if (video.thumbnails?.data && video.thumbnails.data.length > 0) {
        lines.push(`\nThumbnails (${video.thumbnails.data.length}):`);
        for (const thumb of video.thumbnails.data) {
          lines.push(`  • ${thumb.width}x${thumb.height}: ${thumb.uri}`);
        }
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(video, null, 2) },
        ],
      };
    },
  );

  // ─── Upload Ad Video ────────────────────────────────────────
  server.tool(
    "meta_ads_upload_ad_video",
    "Upload a video to Meta for use in ad creatives. Provide either a public video URL (file_url) or an Instagram media ID (source_instagram_media_id) to upload directly from IG. Returns a video_id for use in create_ad_creative. Useful for promoting Instagram Reels.",
    {
      account_id: z.string().describe("Ad account ID"),
      file_url: z.string().optional().describe("Public URL of the video file (MP4). Required unless source_instagram_media_id is provided. Can be an Instagram Reel media_url."),
      source_instagram_media_id: z.string().optional().describe("Instagram media ID (V2) to upload an IG video directly to the ad library. Alternative to file_url — simplifies the Reel promotion flow."),
      name: z.string().optional().describe("Name of the video in the ad library (for organization). Different from title."),
      title: z.string().optional().describe("Title for the video"),
      description: z.string().optional().describe("Description for the video"),
    },
    async ({ account_id, file_url, source_instagram_media_id, name, title, description }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {};

      if (source_instagram_media_id) {
        body.source_instagram_media_id = source_instagram_media_id;
      } else if (file_url) {
        // SSRF guard: Meta will fetch this URL on its end, but we still want to
        // refuse forwarding URLs that look like internal addresses — both as a
        // belt-and-braces measure and so the rejection happens with a clear
        // error here instead of a generic Meta-side failure later.
        try {
          await assertSafePublicUrl(file_url);
        } catch (err) {
          if (err instanceof UnsafeUrlError) {
            throw new Error(`Refusing to forward file_url to Meta: ${err.message}`);
          }
          throw err;
        }
        body.file_url = file_url;
      } else {
        throw new Error("Either file_url or source_instagram_media_id is required.");
      }

      if (name) body.name = name;
      if (title) body.title = title;
      if (description) body.description = description;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/advideos`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Video uploaded successfully!\nID: ${result.id}\nName: ${name ?? "N/A"}\nTitle: ${title ?? "N/A"}\n\nUse this video_id "${result.id}" when creating a creative with create_ad_creative (video_id parameter).`,
          },
        ],
      };
    },
  );
}
