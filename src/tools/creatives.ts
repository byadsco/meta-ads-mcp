import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import type { AdCreative, MetaApiResponse } from "../meta/types/index.js";
import { logger } from "../utils/logger.js";

const ctaEnum = z.enum([
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "SUBSCRIBE", "CONTACT_US",
  "GET_OFFER", "BOOK_TRAVEL", "DOWNLOAD", "APPLY_NOW", "BUY_NOW",
  "GET_QUOTE", "ORDER_NOW", "WATCH_MORE", "SEND_MESSAGE", "WHATSAPP_MESSAGE",
]);

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
        path = `/${ad_id}/adcreatives`;
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

  // ─── Create Ad Creative ──────────────────────────────────────
  server.tool(
    "meta_ads_create_ad_creative",
    "Create a new ad creative with image/video, text, headline, and call-to-action. The creative can then be used when creating ads.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Creative name"),
      page_id: z.string().describe("Facebook Page ID (required as the ad's identity)"),
      instagram_actor_id: z.string().optional().describe("Instagram account ID"),
      image_hash: z.string().optional().describe("Image hash from upload_ad_image"),
      image_url: z.string().optional().describe("Image URL (alternative to image_hash)"),
      video_id: z.string().optional().describe("Video ID"),
      link_url: z.string().optional().describe("Destination URL"),
      message: z.string().optional().describe("Primary text / body copy"),
      headline: z.string().optional().describe("Headline text"),
      description: z.string().optional().describe("Description text (shown below headline)"),
      call_to_action_type: ctaEnum.optional().describe("Call-to-action button type"),
    },
    async ({
      account_id, name, page_id, instagram_actor_id, image_hash, image_url,
      video_id, link_url, message, headline, description, call_to_action_type,
    }) => {
      const id = normalizeAccountId(account_id);

      // Build object_story_spec for link ads
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

      const objectStorySpec: Record<string, unknown> = {
        page_id,
      };

      if (video_id) {
        objectStorySpec.video_data = {
          video_id,
          ...linkData,
        };
      } else {
        objectStorySpec.link_data = linkData;
      }

      if (instagram_actor_id) {
        objectStorySpec.instagram_actor_id = instagram_actor_id;
      }

      const body: Record<string, string | number | boolean> = {
        name,
        object_story_spec: JSON.stringify(objectStorySpec),
      };

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/adcreatives`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Creative created successfully!\nID: ${result.id}\nName: ${name}\nPage: ${page_id}\nCTA: ${call_to_action_type ?? "N/A"}`,
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
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;

      await metaApiClient.postForm<{ success: boolean }>(`/${creative_id}`, body);

      return {
        content: [
          { type: "text", text: `Creative ${creative_id} updated successfully.` },
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

      // Download the image
      logger.info({ image_url }, "Downloading image for upload");
      const imageResponse = await fetch(image_url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
      const extension = contentType.includes("png") ? ".png" : ".jpg";

      // Upload to Meta via multipart form
      const formData = new FormData();
      formData.set(
        "filename",
        new Blob([imageBuffer], { type: contentType }),
        `image${extension}`,
      );
      if (name) formData.set("name", name);

      const result = await metaApiClient.postMultipart<{ images: Record<string, { hash: string; url: string; name?: string }> }>(
        `/${id}/adimages`,
        formData,
      );

      // Extract the first image result
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
    },
  );
}
