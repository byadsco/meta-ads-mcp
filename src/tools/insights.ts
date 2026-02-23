import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, truncateResponse } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { INSIGHTS_DEFAULT_FIELDS } from "../meta/types/insights.js";
import type { InsightsResult, MetaApiResponse } from "../meta/types/index.js";

const datePresetEnum = z.enum([
  "today", "yesterday", "this_month", "last_month", "this_quarter",
  "maximum", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d",
  "last_90d", "last_week_mon_sun", "last_week_sun_sat", "last_quarter",
  "last_year", "this_week_mon_today", "this_week_sun_today", "this_year",
]);

const breakdownEnum = z.enum([
  "age", "gender", "country", "region", "dma",
  "impression_device", "device_platform", "platform_position",
  "publisher_platform", "product_id", "frequency_value",
  "hourly_stats_aggregated_by_advertiser_time_zone",
  "hourly_stats_aggregated_by_audience_time_zone",
  "body_asset", "call_to_action_asset", "description_asset",
  "image_asset", "link_url_asset", "title_asset", "video_asset",
]);

const attributionWindowEnum = z.enum(["1d_click", "7d_click", "1d_view", "28d_click"]);

const levelEnum = z.enum(["ad", "adset", "campaign", "account"]);

export function registerInsightsTools(server: McpServer): void {
  // ─── Get Insights ────────────────────────────────────────────
  server.tool(
    "meta_ads_get_insights",
    "Get performance insights (metrics) for a campaign, ad set, ad, or account. Supports breakdowns, date ranges, attribution windows, and time series.",
    {
      object_id: z.string().describe("Campaign, Ad Set, Ad, or Account ID (use act_XXX for accounts)"),
      level: levelEnum.optional().describe("Aggregation level — useful when querying account/campaign to break down to ad set or ad level"),
      time_range: z
        .object({
          since: z.string().describe("Start date YYYY-MM-DD"),
          until: z.string().describe("End date YYYY-MM-DD"),
        })
        .optional()
        .describe("Custom date range"),
      date_preset: datePresetEnum.optional().describe("Predefined date range (alternative to time_range)"),
      breakdowns: z.array(breakdownEnum).optional().describe("Breakdown dimensions (e.g., age, gender, country)"),
      fields: z.array(z.string()).optional().describe("Metrics to retrieve (defaults to standard set)"),
      action_attribution_windows: z.array(attributionWindowEnum).optional(),
      time_increment: z
        .union([
          z.number().min(1).max(90),
          z.enum(["monthly", "all_days"]),
        ])
        .optional()
        .describe("Time increment for series data — number of days, 'monthly', or 'all_days'"),
      limit: z.number().min(1).max(1000).default(100),
    },
    async ({
      object_id, level, time_range, date_preset, breakdowns,
      fields, action_attribution_windows, time_increment, limit,
    }) => {
      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);

      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (level) params.level = level;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (date_preset) params.date_preset = date_preset;
      if (breakdowns && breakdowns.length > 0) params.breakdowns = breakdowns.join(",");
      if (action_attribution_windows && action_attribution_windows.length > 0) {
        params.action_attribution_windows = JSON.stringify(action_attribution_windows);
      }
      if (time_increment !== undefined) params.time_increment = String(time_increment);

      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${object_id}/insights`,
        params,
      );

      const insights = response.data ?? [];

      if (insights.length === 0) {
        return {
          content: [
            { type: "text", text: "No insights data available for the specified parameters." },
          ],
        };
      }

      // Build summary
      const summary = insights.length === 1 && !breakdowns?.length
        ? buildSingleInsightSummary(insights[0])
        : `${insights.length} row(s) of insights data returned.`;

      const jsonStr = truncateResponse(JSON.stringify(insights, null, 2));

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );

  // ─── Get Account Insights ────────────────────────────────────
  server.tool(
    "meta_ads_get_account_insights",
    "Quick account performance summary. Returns key metrics for the specified date range at account level.",
    {
      account_id: z.string().describe("Ad account ID"),
      date_preset: datePresetEnum.default("last_30d"),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, date_preset, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${id}/insights`,
        { fields: fieldsParam, date_preset },
      );

      const insights = response.data ?? [];

      if (insights.length === 0) {
        return {
          content: [
            { type: "text", text: `No insights data for account ${account_id} (${date_preset}).` },
          ],
        };
      }

      const row = insights[0];
      const summary = buildSingleInsightSummary(row);

      return {
        content: [
          { type: "text", text: `Account Insights (${date_preset}):\n\n${summary}` },
          { type: "text", text: JSON.stringify(row, null, 2) },
        ],
      };
    },
  );
}

function buildSingleInsightSummary(row: InsightsResult): string {
  const lines: string[] = [];
  lines.push(`Period: ${row.date_start} → ${row.date_stop}`);
  if (row.impressions) lines.push(`Impressions: ${Number(row.impressions).toLocaleString()}`);
  if (row.reach) lines.push(`Reach: ${Number(row.reach).toLocaleString()}`);
  if (row.clicks) lines.push(`Clicks: ${Number(row.clicks).toLocaleString()}`);
  if (row.spend) lines.push(`Spend: $${Number(row.spend).toFixed(2)}`);
  if (row.ctr) lines.push(`CTR: ${Number(row.ctr).toFixed(2)}%`);
  if (row.cpc) lines.push(`CPC: $${Number(row.cpc).toFixed(2)}`);
  if (row.cpm) lines.push(`CPM: $${Number(row.cpm).toFixed(2)}`);
  if (row.frequency) lines.push(`Frequency: ${Number(row.frequency).toFixed(2)}`);

  if (row.actions && row.actions.length > 0) {
    lines.push("\nActions:");
    for (const action of row.actions.slice(0, 10)) {
      lines.push(`  • ${action.action_type}: ${action.value}`);
    }
  }

  return lines.join("\n");
}
