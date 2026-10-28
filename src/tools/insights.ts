import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { truncateResponse, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { INSIGHTS_DEFAULT_FIELDS } from "../meta/types/insights.js";
import type { InsightsResult, MetaApiResponse } from "../meta/types/index.js";
import {
  enforceInsightsGuardrails,
  applyAttributionDefault,
} from "./insights-guardrails.js";
import { buildSingleInsightSummary } from "./insights-helpers.js";
import { READ } from "./_register.js";

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

export const filteringEntrySchema = z.object({
  field: z.string(),
  operator: z.enum([
    "EQUAL", "NOT_EQUAL", "GREATER_THAN", "GREATER_THAN_OR_EQUAL",
    "LESS_THAN", "LESS_THAN_OR_EQUAL", "IN_RANGE", "NOT_IN_RANGE",
    "CONTAIN", "NOT_CONTAIN", "IN", "NOT_IN", "STARTS_WITH",
  ]),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
});

export function registerInsightsTools(server: McpServer): void {
  // ─── Get Insights ────────────────────────────────────────────
  // Power tool — full control over breakdowns, attribution, time series.
  // For semantic, agent-friendly views see ads_insights_* tools.
  server.registerTool(
    "ads_get_insights",
    {
      description:
        "Get performance insights (metrics) for a campaign, ad set, ad, or account. Supports breakdowns, date ranges, attribution windows, and time series. Unsafe combos (account-level + high-cardinality breakdowns, wide date ranges + breakdowns in sync) are rejected early — use ads_run_report_and_wait for those. Recommended: pass filtering=[{field:\"ad.impressions\",operator:\"GREATER_THAN\",value:0}] to skip objects without data.",
      inputSchema: {
        object_id: z.string().describe("Campaign, Ad Set, Ad, or Account ID (use act_XXX for accounts)"),
        level: levelEnum.optional().describe("Aggregation level — useful when querying account/campaign to break down to ad set or ad level"),
        time_range: z
          .object({
            since: z.string().describe("Start date YYYY-MM-DD"),
            until: z.string().describe("End date YYYY-MM-DD"),
          })
          .optional()
          .describe("Custom date range (prefer date_preset when one matches — it's more efficient server-side)"),
        date_preset: datePresetEnum.optional().describe("Predefined date range (preferred over time_range for stability and performance)"),
        breakdowns: z.array(breakdownEnum).optional().describe("Breakdown dimensions. Avoid product_id / asset-level on account-wide queries."),
        fields: z.array(z.string()).optional().describe("Metrics to retrieve (defaults to standard set)"),
        action_attribution_windows: z.array(attributionWindowEnum).optional(),
        use_unified_attribution_setting: z
          .boolean()
          .default(true)
          .describe("Default true: match Ads Manager behaviour (Meta change effective 2025-06-10). Set false only for bespoke attribution."),
        filtering: z
          .array(filteringEntrySchema)
          .optional()
          .describe("Server-side filter, e.g. [{field:\"ad.impressions\",operator:\"GREATER_THAN\",value:0}] to skip empty objects."),
        time_increment: z
          .union([
            z.number().min(1).max(90),
            z.enum(["monthly", "all_days"]),
          ])
          .optional()
          .describe("Time increment for series data — number of days, 'monthly', or 'all_days'"),
        limit: z.number().min(1).max(1000).default(100),
      },
      annotations: { ...READ },
    },
    async ({
      object_id, level, time_range, date_preset, breakdowns,
      fields, action_attribution_windows, use_unified_attribution_setting,
      filtering, time_increment, limit,
    }) => {
      const objectId = validateMetaId(object_id, "object");
      enforceInsightsGuardrails({
        level,
        breakdowns,
        date_preset,
        time_range,
        is_async: false,
      });

      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);

      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      applyAttributionDefault(params, use_unified_attribution_setting);

      if (level) params.level = level;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (date_preset) params.date_preset = date_preset;
      if (breakdowns && breakdowns.length > 0) params.breakdowns = breakdowns.join(",");
      if (action_attribution_windows && action_attribution_windows.length > 0) {
        params.action_attribution_windows = JSON.stringify(action_attribution_windows);
      }
      if (filtering && filtering.length > 0) {
        params.filtering = JSON.stringify(filtering);
      }
      if (time_increment !== undefined) params.time_increment = String(time_increment);

      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${objectId}/insights`,
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

  // Note: ads_get_account_insights from v2 has been replaced by
  // ads_insights_advertiser_context (see insights-views.ts).
}
