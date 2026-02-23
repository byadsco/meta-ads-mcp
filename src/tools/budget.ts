import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";

export function registerBudgetTools(server: McpServer): void {
  // ─── Create Budget Schedule ──────────────────────────────────
  server.tool(
    "meta_ads_create_budget_schedule",
    "Schedule a temporary budget increase for a campaign during high-demand periods (e.g., Black Friday, product launches).",
    {
      campaign_id: z.string().describe("Campaign ID"),
      budget_value: z
        .string()
        .describe("Budget amount in cents (for ABSOLUTE) or multiplier value (for MULTIPLIER)"),
      budget_value_type: z
        .enum(["ABSOLUTE", "MULTIPLIER"])
        .describe("ABSOLUTE = set exact budget in cents, MULTIPLIER = multiply current budget"),
      time_start: z.string().describe("ISO 8601 start time for the budget increase"),
      time_end: z.string().describe("ISO 8601 end time for the budget increase"),
    },
    async ({ campaign_id, budget_value, budget_value_type, time_start, time_end }) => {
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${campaign_id}/budget_schedules`,
        {
          budget_value,
          budget_value_type,
          time_start,
          time_end,
        },
      );

      return {
        content: [
          {
            type: "text",
            text: `Budget schedule created!\nID: ${result.id}\nCampaign: ${campaign_id}\nValue: ${budget_value} (${budget_value_type})\nPeriod: ${time_start} → ${time_end}`,
          },
        ],
      };
    },
  );
}
