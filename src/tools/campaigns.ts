import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { CAMPAIGN_DEFAULT_FIELDS } from "../meta/types/campaign.js";
import type { Campaign, MetaApiResponse } from "../meta/types/index.js";

const objectiveEnum = z.enum([
  "OUTCOME_AWARENESS",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_SALES",
  "OUTCOME_TRAFFIC",
  "OUTCOME_APP_PROMOTION",
]);

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

const bidStrategyEnum = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

const specialAdCategoryEnum = z.enum([
  "NONE",
  "EMPLOYMENT",
  "HOUSING",
  "CREDIT",
  "ISSUES_ELECTIONS_POLITICS",
]);

export function registerCampaignTools(server: McpServer): void {
  // ─── Get Campaigns ───────────────────────────────────────────
  server.tool(
    "meta_ads_get_campaigns",
    "Get campaigns for an ad account. Filter by status to see active, paused, or all campaigns.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      status_filter: z
        .array(statusEnum)
        .optional()
        .describe("Filter by status (e.g., ['ACTIVE', 'PAUSED'])"),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, status_filter, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...CAMPAIGN_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          {
            field: "effective_status",
            operator: "IN",
            value: status_filter,
          },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<Campaign>>(
        `/${id}/campaigns`,
        params,
      );

      const campaigns = response.data ?? [];

      const text =
        campaigns.length === 0
          ? "No campaigns found."
          : campaigns
              .map(
                (c) =>
                  `• ${c.name} (${c.id}) — ${c.status} — Objective: ${c.objective} — Budget: ${c.daily_budget ? `${c.daily_budget}/day` : c.lifetime_budget ? `${c.lifetime_budget} lifetime` : "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${campaigns.length} campaign(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(campaigns, null, 2) },
        ],
      };
    },
  );

  // ─── Get Campaign Details ────────────────────────────────────
  server.tool(
    "meta_ads_get_campaign_details",
    "Get detailed information about a specific campaign.",
    {
      campaign_id: z.string().describe("Campaign ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ campaign_id, fields }) => {
      const fieldsParam = buildFieldsParam(fields, [...CAMPAIGN_DEFAULT_FIELDS]);
      const campaign = await metaApiClient.get<Campaign>(`/${campaign_id}`, {
        fields: fieldsParam,
      });

      return {
        content: [
          {
            type: "text",
            text: `Campaign: ${campaign.name}\nID: ${campaign.id}\nStatus: ${campaign.status} (effective: ${campaign.effective_status})\nObjective: ${campaign.objective}\nBuying Type: ${campaign.buying_type}\nBid Strategy: ${campaign.bid_strategy ?? "N/A"}\nDaily Budget: ${campaign.daily_budget ?? "N/A"}\nLifetime Budget: ${campaign.lifetime_budget ?? "N/A"}\nCreated: ${campaign.created_time}`,
          },
          { type: "text", text: JSON.stringify(campaign, null, 2) },
        ],
      };
    },
  );

  // ─── Create Campaign ─────────────────────────────────────────
  server.tool(
    "meta_ads_create_campaign",
    "Create a new Meta advertising campaign. Uses outcome-based (ODAX) objectives. Campaigns are created in PAUSED status by default.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).max(400).describe("Campaign name"),
      objective: objectiveEnum.describe(
        "Campaign objective (OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_SALES, OUTCOME_APP_PROMOTION)",
      ),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      special_ad_categories: z
        .array(specialAdCategoryEnum)
        .default(["NONE"])
        .describe("Special ad categories (NONE, EMPLOYMENT, HOUSING, CREDIT, ISSUES_ELECTIONS_POLITICS)"),
      daily_budget: z
        .number()
        .optional()
        .describe("Daily budget in cents (e.g., 5000 = $50.00)"),
      lifetime_budget: z
        .number()
        .optional()
        .describe("Lifetime budget in cents"),
      bid_strategy: bidStrategyEnum.optional(),
      buying_type: z.enum(["AUCTION", "RESERVED"]).default("AUCTION"),
    },
    async ({
      account_id,
      name,
      objective,
      status,
      special_ad_categories,
      daily_budget,
      lifetime_budget,
      bid_strategy,
      buying_type,
    }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, unknown> = {
        name,
        objective,
        status,
        special_ad_categories,
        buying_type,
      };

      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (bid_strategy) body.bid_strategy = bid_strategy;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/campaigns`,
        body as Record<string, string | number | boolean>,
      );

      return {
        content: [
          {
            type: "text",
            text: `Campaign created successfully!\nID: ${result.id}\nName: ${name}\nObjective: ${objective}\nStatus: ${status}`,
          },
        ],
      };
    },
  );

  // ─── Update Campaign ─────────────────────────────────────────
  server.tool(
    "meta_ads_update_campaign",
    "Update an existing campaign's name, status, budget, or bid strategy.",
    {
      campaign_id: z.string().describe("Campaign ID to update"),
      name: z.string().optional(),
      status: statusEnum.optional(),
      daily_budget: z.number().optional().describe("Daily budget in cents"),
      lifetime_budget: z.number().optional().describe("Lifetime budget in cents"),
      bid_strategy: bidStrategyEnum.optional(),
    },
    async ({ campaign_id, name, status, daily_budget, lifetime_budget, bid_strategy }) => {
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (bid_strategy !== undefined) body.bid_strategy = bid_strategy;

      await metaApiClient.postForm<{ success: boolean }>(
        `/${campaign_id}`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Campaign ${campaign_id} updated successfully.\nChanges: ${JSON.stringify(body)}`,
          },
        ],
      };
    },
  );

  // ─── Delete Campaign ─────────────────────────────────────────
  server.tool(
    "meta_ads_delete_campaign",
    "Delete a campaign (soft delete — sets status to DELETED). The campaign can still be viewed but will stop serving.",
    {
      campaign_id: z.string().describe("Campaign ID to delete"),
    },
    async ({ campaign_id }) => {
      await metaApiClient.postForm<{ success: boolean }>(`/${campaign_id}`, {
        status: "DELETED",
      });

      return {
        content: [
          {
            type: "text",
            text: `Campaign ${campaign_id} has been deleted (status set to DELETED).`,
          },
        ],
      };
    },
  );
}
