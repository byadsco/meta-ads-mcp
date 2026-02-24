import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import type { MetaApiResponse } from "../meta/types/index.js";

const adFormatEnum = z.enum([
  "DESKTOP_FEED_STANDARD",
  "MOBILE_FEED_STANDARD",
  "MOBILE_FEED_BASIC",
  "MOBILE_INTERSTITIAL",
  "MOBILE_BANNER",
  "INSTAGRAM_STANDARD",
  "INSTAGRAM_STORY",
  "INSTAGRAM_REELS",
  "RIGHT_COLUMN_STANDARD",
  "MARKETPLACE_MOBILE",
  "AUDIENCE_NETWORK_OUTSTREAM_VIDEO",
  "MESSENGER_MOBILE_INBOX_MEDIA",
  "FACEBOOK_STORY_MOBILE",
  "FACEBOOK_REELS_MOBILE",
]);

interface AdPreview {
  body: string;
}

export function registerPreviewTools(server: McpServer): void {
  // ─── Get Ad Preview ───────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_preview",
    "Generate a preview of an existing ad in a specific placement format (feed, stories, reels, etc.). Returns HTML preview and shareable link.",
    {
      ad_id: z.string().describe("Ad ID to preview"),
      ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD").describe("Ad placement format"),
    },
    async ({ ad_id, ad_format }) => {
      const response = await metaApiClient.get<MetaApiResponse<AdPreview>>(
        `/${ad_id}/previews`,
        { ad_format },
      );
      const previews = response.data ?? [];

      if (previews.length === 0) {
        return {
          content: [{ type: "text", text: "No preview available for this ad/format." }],
        };
      }

      // Extract iframe src URL from the HTML body if possible
      const html = previews[0].body;
      const iframeSrcMatch = html.match(/src="([^"]+)"/);
      const previewUrl = iframeSrcMatch ? iframeSrcMatch[1].replace(/&amp;/g, "&") : null;

      const lines: string[] = [
        `Ad Preview (${ad_format}):`,
      ];
      if (previewUrl) {
        lines.push(`\nPreview URL: ${previewUrl}`);
      }
      lines.push(`\nShareable — copy the URL above to share with clients without Business Manager access.`);

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: `Raw HTML:\n${html}` },
        ],
      };
    },
  );

  // ─── Generate Preview from Creative Spec ──────────────────────
  server.tool(
    "meta_ads_generate_preview",
    "Generate a preview from a creative specification without creating an actual ad. Useful for previewing creative concepts before launch.",
    {
      account_id: z.string().describe("Ad account ID"),
      ad_format: adFormatEnum.default("MOBILE_FEED_STANDARD"),
      creative: z
        .object({
          object_story_spec: z
            .object({
              page_id: z.string().describe("Facebook Page ID"),
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
                  message: z.string().optional(),
                  name: z.string().optional(),
                  description: z.string().optional(),
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
        })
        .describe("Creative specification"),
    },
    async ({ account_id, ad_format, creative }) => {
      const id = normalizeAccountId(account_id);

      const response = await metaApiClient.get<MetaApiResponse<AdPreview>>(
        `/${id}/generatepreviews`,
        {
          ad_format,
          creative: JSON.stringify(creative),
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

      return {
        content: [
          {
            type: "text",
            text: previewUrl
              ? `Preview generated (${ad_format}):\n\nPreview URL: ${previewUrl}`
              : `Preview generated (${ad_format}).`,
          },
          { type: "text", text: `Raw HTML:\n${html}` },
        ],
      };
    },
  );
}
