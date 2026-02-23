import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import type { Ad, MetaApiResponse } from "../meta/types/index.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

export function registerAdTools(server: McpServer): void {
  // ─── Get Ads ─────────────────────────────────────────────────
  server.tool(
    "meta_ads_get_ads",
    "Get ads for an ad account. Filter by campaign, ad set, or status.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      campaign_id: z.string().optional().describe("Filter by campaign ID"),
      adset_id: z.string().optional().describe("Filter by ad set ID"),
      status_filter: z.array(statusEnum).optional(),
    },
    async ({ account_id, limit, campaign_id, adset_id, status_filter }) => {
      let path: string;
      if (adset_id) {
        path = `/${adset_id}/ads`;
      } else if (campaign_id) {
        path = `/${campaign_id}/ads`;
      } else {
        path = `/${normalizeAccountId(account_id)}/ads`;
      }

      const fieldsParam = buildFieldsParam(undefined, [...AD_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: status_filter },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<Ad>>(path, params);
      const ads = response.data ?? [];

      const text =
        ads.length === 0
          ? "No ads found."
          : ads
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Creative: ${a.creative?.id ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${ads.length} ad(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(ads, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Details ──────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_details",
    "Get detailed information about a specific ad.",
    {
      ad_id: z.string().describe("Ad ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ ad_id, fields }) => {
      const fieldsParam = buildFieldsParam(fields, [...AD_DEFAULT_FIELDS, "bid_amount", "tracking_specs"]);
      const ad = await metaApiClient.get<Ad>(`/${ad_id}`, { fields: fieldsParam });

      return {
        content: [
          {
            type: "text",
            text: `Ad: ${ad.name}\nID: ${ad.id}\nAd Set: ${ad.adset_id}\nCampaign: ${ad.campaign_id}\nStatus: ${ad.status} (effective: ${ad.effective_status})\nCreative ID: ${ad.creative?.id ?? "N/A"}\nCreated: ${ad.created_time}`,
          },
          { type: "text", text: JSON.stringify(ad, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad ───────────────────────────────────────────────
  server.tool(
    "meta_ads_create_ad",
    "Create a new ad within an ad set using an existing creative. Ads are created in PAUSED status by default.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Ad name"),
      adset_id: z.string().describe("Ad set ID to place this ad in"),
      creative_id: z.string().describe("Creative ID to use for this ad"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      tracking_specs: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Tracking specifications"),
    },
    async ({ account_id, name, adset_id, creative_id, status, tracking_specs }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        adset_id,
        creative: JSON.stringify({ creative_id }),
        status,
      };

      if (tracking_specs) body.tracking_specs = JSON.stringify(tracking_specs);

      const result = await metaApiClient.postForm<{ id: string }>(`/${id}/ads`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad created successfully!\nID: ${result.id}\nName: ${name}\nAd Set: ${adset_id}\nCreative: ${creative_id}\nStatus: ${status}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad ───────────────────────────────────────────────
  server.tool(
    "meta_ads_update_ad",
    "Update an existing ad's name, status, or creative.",
    {
      ad_id: z.string().describe("Ad ID to update"),
      name: z.string().optional(),
      status: statusEnum.optional(),
      creative_id: z.string().optional().describe("New creative ID"),
    },
    async ({ ad_id, name, status, creative_id }) => {
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (creative_id !== undefined) body.creative = JSON.stringify({ creative_id });

      await metaApiClient.postForm<{ success: boolean }>(`/${ad_id}`, body);

      return {
        content: [
          { type: "text", text: `Ad ${ad_id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Delete Ad ───────────────────────────────────────────────
  server.tool(
    "meta_ads_delete_ad",
    "Delete an ad (soft delete — sets status to DELETED).",
    {
      ad_id: z.string().describe("Ad ID to delete"),
    },
    async ({ ad_id }) => {
      await metaApiClient.postForm<{ success: boolean }>(`/${ad_id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad ${ad_id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
