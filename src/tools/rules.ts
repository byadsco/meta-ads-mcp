import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, truncateResponse } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { RULE_DEFAULT_FIELDS } from "../meta/types/rule.js";
import type { AdRule, AdRuleHistory, MetaApiResponse } from "../meta/types/index.js";

const executionTypeEnum = z.enum([
  "PAUSE", "UNPAUSE", "CHANGE_BUDGET", "CHANGE_BID",
  "ROTATE", "NOTIFICATION",
]);

const scheduleTypeEnum = z.enum([
  "CUSTOM", "SEMI_HOURLY", "HOURLY", "DAILY", "WEEKLY",
]);

export function registerRuleTools(server: McpServer): void {
  // ─── Get Ad Rules ─────────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_rules",
    "List automated rules for an ad account. Shows rules that auto-pause, adjust budgets, or send notifications based on performance.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...RULE_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<AdRule>>(
        `/${id}/adrules_library`,
        { fields: fieldsParam, limit },
      );
      const rules = response.data ?? [];

      const text =
        rules.length === 0
          ? "No automated rules found."
          : rules
              .map(
                (r) =>
                  `• ${r.name} (${r.id}) — Status: ${r.status} — Action: ${r.execution_spec?.execution_type ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${rules.length} rule(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(rules, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Rule ───────────────────────────────────────────
  server.tool(
    "meta_ads_create_ad_rule",
    "Create an automated rule. Examples: pause adsets when CPL > $20, notify when CTR < 1%, increase budget when ROAS > 3x.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Rule name"),
      evaluation_spec: z
        .object({
          evaluation_type: z.enum(["TRIGGER", "SCHEDULE"]).describe("TRIGGER for real-time, SCHEDULE for periodic"),
          filters: z
            .array(
              z.object({
                field: z.string().describe("Metric field (e.g., cost_per_action_type, ctr, impressions)"),
                value: z.union([z.string(), z.number()]).describe("Threshold value"),
                operator: z.enum(["GREATER_THAN", "LESS_THAN", "EQUAL", "NOT_EQUAL", "IN_RANGE", "NOT_IN_RANGE"])
                  .describe("Comparison operator"),
              }),
            )
            .describe("Conditions that trigger the rule"),
        })
        .describe("When to evaluate the rule"),
      execution_spec: z
        .object({
          execution_type: executionTypeEnum.describe("Action to take when conditions are met"),
          execution_options: z
            .array(
              z.object({
                field: z.string(),
                value: z.union([z.string(), z.number()]),
                operator: z.enum(["EQUAL", "INCREASE_BY", "DECREASE_BY"]).optional(),
              }),
            )
            .optional()
            .describe("Options for CHANGE_BUDGET/CHANGE_BID execution types"),
        })
        .describe("What to do when triggered"),
      schedule_spec: z
        .object({
          schedule_type: scheduleTypeEnum.describe("How often to evaluate"),
        })
        .optional(),
    },
    async ({ account_id, name, evaluation_spec, execution_spec, schedule_spec }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        evaluation_spec: JSON.stringify(evaluation_spec),
        execution_spec: JSON.stringify(execution_spec),
      };

      if (schedule_spec) {
        body.schedule_spec = JSON.stringify(schedule_spec);
      }

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/adrules_library`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Automated rule created!\nID: ${result.id}\nName: ${name}\nAction: ${execution_spec.execution_type}\nEval: ${evaluation_spec.evaluation_type}`,
          },
        ],
      };
    },
  );

  // ─── Get Rule Details ─────────────────────────────────────────
  server.tool(
    "meta_ads_get_rule_details",
    "Get detailed information about an automated rule and its execution history.",
    {
      rule_id: z.string().describe("Rule ID"),
      fields: z.array(z.string()).optional(),
      include_history: z.boolean().default(false).describe("Include rule execution history"),
    },
    async ({ rule_id, fields, include_history }) => {
      const fieldsParam = buildFieldsParam(fields, [...RULE_DEFAULT_FIELDS]);

      const rule = await metaApiClient.get<AdRule>(
        `/${rule_id}`,
        { fields: fieldsParam },
      );

      const content: Array<{ type: "text"; text: string }> = [
        {
          type: "text",
          text: `Rule: ${rule.name} (${rule.id})\nStatus: ${rule.status}\nAction: ${rule.execution_spec?.execution_type ?? "N/A"}`,
        },
        { type: "text", text: JSON.stringify(rule, null, 2) },
      ];

      if (include_history) {
        const historyResponse = await metaApiClient.get<MetaApiResponse<AdRuleHistory>>(
          `/${rule_id}/history`,
          { limit: 50 },
        );
        const history = historyResponse.data ?? [];

        if (history.length > 0) {
          const historyText = truncateResponse(JSON.stringify(history, null, 2));
          content.push({
            type: "text",
            text: `\nExecution History (${history.length} entries):\n${historyText}`,
          });
        }
      }

      return { content };
    },
  );

  // ─── Update Ad Rule ───────────────────────────────────────────
  server.tool(
    "meta_ads_update_ad_rule",
    "Update an existing automated rule's name, status, or specs.",
    {
      rule_id: z.string().describe("Rule ID to update"),
      name: z.string().optional().describe("New name"),
      status: z.enum(["ENABLED", "DISABLED"]).optional().describe("Enable or disable the rule"),
      evaluation_spec: z
        .object({
          evaluation_type: z.enum(["TRIGGER", "SCHEDULE"]),
          filters: z.array(
            z.object({
              field: z.string(),
              value: z.union([z.string(), z.number()]),
              operator: z.string(),
            }),
          ),
        })
        .optional(),
      execution_spec: z
        .object({
          execution_type: executionTypeEnum,
          execution_options: z
            .array(
              z.object({
                field: z.string(),
                value: z.union([z.string(), z.number()]),
                operator: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    },
    async ({ rule_id, name, status, evaluation_spec, execution_spec }) => {
      const body: Record<string, string | number | boolean> = {};
      if (name) body.name = name;
      if (status) body.status = status;
      if (evaluation_spec) body.evaluation_spec = JSON.stringify(evaluation_spec);
      if (execution_spec) body.execution_spec = JSON.stringify(execution_spec);

      await metaApiClient.postForm<{ success: boolean }>(`/${rule_id}`, body);

      return {
        content: [
          { type: "text", text: `Rule ${rule_id} updated successfully.` },
        ],
      };
    },
  );

  // ─── Delete Ad Rule ───────────────────────────────────────────
  server.tool(
    "meta_ads_delete_ad_rule",
    "Delete an automated rule.",
    {
      rule_id: z.string().describe("Rule ID to delete"),
    },
    async ({ rule_id }) => {
      await metaApiClient.delete<{ success: boolean }>(`/${rule_id}`);

      return {
        content: [
          { type: "text", text: `Rule ${rule_id} deleted successfully.` },
        ],
      };
    },
  );
}
