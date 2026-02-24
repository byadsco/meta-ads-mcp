import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { truncateResponse } from "../utils/format.js";
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
]);

const levelEnum = z.enum(["ad", "adset", "campaign", "account"]);

interface AsyncReportRun {
  id: string;
  report_run_id?: string;
}

interface ReportRunStatus {
  id: string;
  async_status: string;
  async_percent_completion: number;
  date_start?: string;
  date_stop?: string;
}

export function registerReportTools(server: McpServer): void {
  // ─── Create Async Report ──────────────────────────────────────
  server.tool(
    "meta_ads_create_async_report",
    "Create an asynchronous report for large data exports. Use this when you need to pull extensive insights data that would timeout with a synchronous request.",
    {
      object_id: z
        .string()
        .describe("Campaign, Ad Set, Ad, or Account ID (use act_XXX for accounts)"),
      level: levelEnum.optional().describe("Aggregation level"),
      time_range: z
        .object({
          since: z.string().describe("Start date YYYY-MM-DD"),
          until: z.string().describe("End date YYYY-MM-DD"),
        })
        .optional(),
      date_preset: datePresetEnum.optional(),
      breakdowns: z.array(breakdownEnum).optional(),
      fields: z.array(z.string()).optional().describe("Metrics to include"),
      time_increment: z
        .union([
          z.number().min(1).max(90),
          z.enum(["monthly", "all_days"]),
        ])
        .optional()
        .describe("Time increment for series data"),
    },
    async ({ object_id, level, time_range, date_preset, breakdowns, fields, time_increment }) => {
      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);

      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
      };

      if (level) params.level = level;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (date_preset) params.date_preset = date_preset;
      if (breakdowns && breakdowns.length > 0) params.breakdowns = breakdowns.join(",");
      if (time_increment !== undefined) params.time_increment = String(time_increment);

      const result = await metaApiClient.postForm<AsyncReportRun>(
        `/${object_id}/insights`,
        params,
      );

      const reportId = result.report_run_id ?? result.id;

      return {
        content: [
          {
            type: "text",
            text: `Async report created!\nReport Run ID: ${reportId}\n\nUse meta_ads_get_report_status to check progress, then meta_ads_get_report_results to download.`,
          },
        ],
      };
    },
  );

  // ─── Get Report Status ────────────────────────────────────────
  server.tool(
    "meta_ads_get_report_status",
    "Check the status of an asynchronous report. Returns completion percentage and current status.",
    {
      report_run_id: z.string().describe("Report run ID from create_async_report"),
    },
    async ({ report_run_id }) => {
      const status = await metaApiClient.get<ReportRunStatus>(
        `/${report_run_id}`,
        { fields: "id,async_status,async_percent_completion,date_start,date_stop" },
      );

      const isComplete = status.async_status === "Job Completed";

      return {
        content: [
          {
            type: "text",
            text: [
              `Report ${report_run_id}:`,
              `Status: ${status.async_status}`,
              `Progress: ${status.async_percent_completion}%`,
              status.date_start ? `Period: ${status.date_start} → ${status.date_stop}` : "",
              isComplete ? `\nReady! Use meta_ads_get_report_results to download.` : `\nStill processing...`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  // ─── Get Report Results ───────────────────────────────────────
  server.tool(
    "meta_ads_get_report_results",
    "Download the results of a completed async report.",
    {
      report_run_id: z.string().describe("Report run ID"),
      limit: z.number().min(1).max(1000).default(500),
    },
    async ({ report_run_id, limit }) => {
      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${report_run_id}/insights`,
        { limit },
      );
      const results = response.data ?? [];

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No results available. Ensure the report has completed (check with meta_ads_get_report_status).",
            },
          ],
        };
      }

      const jsonStr = truncateResponse(JSON.stringify(results, null, 2));

      return {
        content: [
          { type: "text", text: `Report results: ${results.length} row(s) of data.` },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );
}
