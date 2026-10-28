import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";
import { READ } from "./_register.js";
import { assertSafePublicUrl, UnsafeUrlError } from "../utils/url-guard.js";
import { buildStorySpec, dofFeedProblem } from "../meta/creative-spec.js";
import {
  ctaEnum,
  headlineOptions,
  MAX_HEADLINE_LENGTH,
  MAX_TEXT_OPTIONS,
  resolveTextOptions,
  textOptions,
} from "./creatives.js";

const adFormatEnum = z.enum([
  // Core placements
  "DESKTOP_FEED_STANDARD",
  "MOBILE_FEED_STANDARD",
  "MOBILE_FEED_BASIC",
  "MOBILE_INTERSTITIAL",
  "MOBILE_BANNER",
  "RIGHT_COLUMN_STANDARD",
  "MARKETPLACE_MOBILE",
  // Instagram
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "INSTAGRAM_EXPLORE_CONTEXTUAL",
  "INSTAGRAM_EXPLORE_GRID_HOME",
  "INSTAGRAM_REELS_OVERLAY",
  "INSTAGRAM_PROFILE_FEED",
  "INSTAGRAM_PROFILE_REELS",
  "INSTAGRAM_SEARCH_CHAIN",
  "INSTAGRAM_FEED_WEB",
  // Facebook Stories & Reels
  "FACEBOOK_STORY_MOBILE",
  "FACEBOOK_STORY_STICKER_MOBILE",
  "FACEBOOK_REELS_MOBILE",
  "FACEBOOK_REELS_BANNER",
  "FACEBOOK_REELS_POSTLOOP",
  "FACEBOOK_REELS_STICKER",
  // Messenger & WhatsApp
  "MESSENGER_MOBILE_INBOX_MEDIA",
  "MESSENGER_MOBILE_STORY_MEDIA",
  "WHATSAPP_STATUS_MEDIA",
  // In-stream & Audience Network
  "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
  "INSTREAM_VIDEO_DESKTOP",
  "INSTREAM_VIDEO_MOBILE",
  "SUGGESTED_VIDEO_MOBILE",
]);

interface AdPreview {
  body: string;
}

async function guardImageUrl(url: string, field: string): Promise<void> {
  try {
    await assertSafePublicUrl(url);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new Error(`Refusing to forward ${field} to Meta: ${err.message}`);
    }
    throw err;
  }
}

export function registerPreviewTools(server: McpServer): void {
  // ─── Get Ad Preview ───────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_preview",
    {
      description:
        "Generate a preview of an existing ad in a specific placement format (feed, stories, reels, etc.). Returns HTML preview and shareable link.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID to preview"),
        ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD").describe("Ad placement format"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, ad_format }) => {
      const id = validateMetaId(ad_id, "ad");
      const response = await metaApiClient.get<MetaApiResponse<AdPreview>>(
        `/${id}/previews`,
        { ad_format },
      );
      const previews = response.data ?? [];

      if (previews.length === 0) {
        return {
          content: [{ type: "text", text: "No preview available for this ad/format." }],
        };
      }

      const html = previews[0].body;
      const iframeSrcMatch = html.match(/src="([^"]+)"/);
      const previewUrl = iframeSrcMatch ? iframeSrcMatch[1].replace(/&amp;/g, "&") : null;

      const lines: string[] = [
        `Ad Preview (${ad_format}):`,
      ];
      if (previewUrl) {
        lines.push(`\nPreview URL: ${previewUrl}`);
        lines.push(`\nShareable — copy the URL above to share with clients without Business Manager access.`);
      } else {
        lines.push(`\nMeta returned a preview but no shareable URL could be extracted from it.`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ─── Generate Preview from Creative Spec ──────────────────────
  server.registerTool(
    "ads_generate_preview",
    {
      description:
        "Generate a preview from a creative specification without creating an actual ad. Useful for previewing creative concepts before launch. Either pass the same simple fields as ads_create_ad_creative (page_id, image_hash / image_url / video_id, link_url, primary_texts / headlines / descriptions, call_to_action_type), which build the creative exactly as that tool would, including several text options; or pass a raw creative spec; or pass creative_id to preview a creative that already exists, in any layout (carousel, dynamic creative, placement or language versions, site links, destinations). A creative costs nothing until an ad runs it, so the way to preview those layouts is to create the creative and pass its creative_id. A creative with several text options previews one combination.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD"),
        creative_id: z.string().optional().describe("An existing creative to preview, in any layout. Use instead of the simple fields and creative"),
        page_id: z.string().optional().describe("Facebook Page ID. Use the simple fields or creative, not both."),
        instagram_actor_id: z.string().optional().describe("Instagram account ID for Instagram placements"),
        image_hash: z.string().optional(),
        image_url: z.string().optional().describe("Image URL (alternative to image_hash)"),
        video_id: z.string().optional().describe("Video ID; image_hash or image_url is then its thumbnail"),
        link_url: z.string().optional().describe("Destination URL"),
        message: z.string().optional().describe("Primary text"),
        headline: z.string().max(MAX_HEADLINE_LENGTH).optional(),
        description: z.string().optional(),
        primary_texts: textOptions().describe(`Up to ${MAX_TEXT_OPTIONS} primary texts. Use instead of message.`),
        headlines: headlineOptions().describe(`Up to ${MAX_TEXT_OPTIONS} headlines. Use instead of headline.`),
        descriptions: textOptions().describe(`Up to ${MAX_TEXT_OPTIONS} descriptions. Use instead of description.`),
        call_to_action_type: ctaEnum.optional(),
        creative: z
          .object({
            object_story_spec: z
              .object({
                page_id: z.string().describe("Facebook Page ID"),
                instagram_user_id: z.string().optional(),
                link_data: z
                  .object({
                    image_hash: z.string().optional(),
                    picture: z.string().optional().describe("Image URL"),
                    link: z.string().optional().describe("Destination URL"),
                    message: z.string().optional().describe("Primary text"),
                    name: z.string().optional().describe("Headline"),
                    description: z.string().optional(),
                    call_to_action: z
                      .object({
                        type: z.string(),
                        value: z.object({ link: z.string().optional() }).optional(),
                      })
                      .optional(),
                  })
                  .optional(),
                video_data: z
                  .object({
                    video_id: z.string().optional(),
                    image_hash: z.string().optional(),
                    image_url: z.string().optional(),
                    message: z.string().optional(),
                    title: z.string().optional().describe("Video headline"),
                    link_description: z.string().optional().describe("Video description"),
                    description: z.string().optional().describe("Alias of link_description"),
                    call_to_action: z
                      .object({
                        type: z.string(),
                        value: z.object({ link: z.string().optional() }).optional(),
                      })
                      .optional(),
                  })
                  .optional(),
              })
              .describe("Creative story spec"),
            asset_feed_spec: z
              .object({
                bodies: z.array(z.object({ text: z.string() })).optional(),
                titles: z.array(z.object({ text: z.string() })).optional(),
                descriptions: z.array(z.object({ text: z.string() })).optional(),
                optimization_type: z.string().optional(),
              })
              .optional()
              .describe("Text options, as ads_get_creative_details returns them"),
          })
          .optional()
          .describe("Raw creative specification. Use instead of the simple fields."),
      },
      annotations: { ...READ },
    },
    async ({
      account_id, ad_format, creative_id, page_id, instagram_actor_id, image_hash, image_url, video_id, link_url,
      message, headline, description, primary_texts, headlines, descriptions, call_to_action_type, creative,
    }) => {
      const accountPath = normalizeAccountId(account_id);
      const warnings: string[] = [];
      let spec: Record<string, unknown> = {};

      const simpleFields = {
        page_id, instagram_actor_id, image_hash, image_url, video_id, link_url, message, headline,
        description, primary_texts, headlines, descriptions, call_to_action_type,
      };
      const simpleGiven = Object.entries(simpleFields).filter(([, value]) => value !== undefined).map(([key]) => key);
      if (creative_id !== undefined && (creative || simpleGiven.length > 0)) {
        throw new Error(`Pass creative_id alone: it previews an existing creative (got creative_id and ${[creative ? "creative" : "", ...simpleGiven].filter(Boolean).join(", ")}).`);
      }
      if (creative && simpleGiven.length > 0) {
        throw new Error(`Pass either the simple fields or creative, not both (got creative and ${simpleGiven.join(", ")}).`);
      }

      if (creative_id !== undefined) {
        // Validated before anything else, so a malformed ID never reaches a path.
        validateMetaId(creative_id, "creative");
      } else if (creative) {
        const raw = structuredClone(creative);
        raw.object_story_spec.page_id = validateMetaId(raw.object_story_spec.page_id, "page");
        const linkData = raw.object_story_spec.link_data;
        const videoData = raw.object_story_spec.video_data;
        if (videoData?.video_id) {
          videoData.video_id = validateMetaId(videoData.video_id, "video");
        }
        if (linkData?.picture) await guardImageUrl(linkData.picture, "link_data.picture");
        if (videoData?.image_url) await guardImageUrl(videoData.image_url, "video_data.image_url");
        // Meta reads a video's description from link_description and ignores
        // "description", which earlier versions of this tool documented.
        if (videoData?.description !== undefined) {
          videoData.link_description ??= videoData.description;
          delete videoData.description;
        }
        if (raw.asset_feed_spec?.optimization_type === "DEGREES_OF_FREEDOM") {
          const problem = dofFeedProblem(raw.asset_feed_spec);
          if (problem) throw new Error(`Meta would reject this creative: ${problem}`);
        }
        spec = raw;
      } else if (page_id) {
        if (image_url && !image_hash) await guardImageUrl(image_url, "image_url");
        const story = buildStorySpec({
          pageId: validateMetaId(page_id, "page"),
          instagramUserId: instagram_actor_id ? validateMetaId(instagram_actor_id, "instagram_actor") : undefined,
          imageHash: image_hash,
          imageUrl: image_url,
          videoId: video_id ? validateMetaId(video_id, "video") : undefined,
          linkUrl: link_url,
          primaryTexts: resolveTextOptions(message, primary_texts, "message", "primary_texts"),
          headlines: resolveTextOptions(headline, headlines, "headline", "headlines"),
          descriptions: resolveTextOptions(description, descriptions, "description", "descriptions"),
          callToActionType: call_to_action_type,
        });
        warnings.push(...story.warnings);
        spec = { object_story_spec: story.objectStorySpec };
        if (story.assetFeedSpec) spec.asset_feed_spec = story.assetFeedSpec;
      } else {
        throw new Error("Pass page_id with the simple creative fields, or a raw creative spec.");
      }

      const response = creative_id !== undefined
        ? await metaApiClient.get<MetaApiResponse<AdPreview>>(`/${creative_id}/previews`, { ad_format })
        : await metaApiClient.get<MetaApiResponse<AdPreview>>(
          `/${accountPath}/generatepreviews`,
          {
            ad_format,
            creative: JSON.stringify(spec),
          },
        );
      const previews = response.data ?? [];

      if (previews.length === 0) {
        return {
          content: [{ type: "text", text: "No preview could be generated with the provided spec." }],
        };
      }

      const html = previews[0].body;
      const iframeSrcMatch = html.match(/src="([^"]+)"/);
      const previewUrl = iframeSrcMatch ? iframeSrcMatch[1].replace(/&amp;/g, "&") : null;

      const lines = [
        previewUrl
          ? `Preview generated (${ad_format}):\n\nPreview URL: ${previewUrl}`
          : `Preview generated (${ad_format}). Meta did not return a shareable URL.`,
      ];
      if (spec.asset_feed_spec) {
        lines.push("The creative has several text options; this preview shows one combination.");
      }
      if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((w) => `• ${w}`));

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
