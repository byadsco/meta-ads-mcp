import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { AUDIENCE_DEFAULT_FIELDS } from "../meta/types/audience.js";
import type { CustomAudience, MetaApiResponse } from "../meta/types/index.js";

export function registerAudienceTools(server: McpServer): void {
  // ─── Get Custom Audiences ─────────────────────────────────────
  server.tool(
    "meta_ads_get_custom_audiences",
    "List custom audiences for an ad account. Includes lookalikes, website audiences, customer lists, etc.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<CustomAudience>>(
        `/${id}/customaudiences`,
        { fields: fieldsParam, limit },
      );
      const audiences = response.data ?? [];

      const text =
        audiences.length === 0
          ? "No custom audiences found."
          : audiences
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — Type: ${a.subtype} — Size: ${a.approximate_count_lower_bound ?? "?"}-${a.approximate_count_upper_bound ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${audiences.length} audience(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(audiences, null, 2) },
        ],
      };
    },
  );

  // ─── Get Audience Details ─────────────────────────────────────
  server.tool(
    "meta_ads_get_audience_details",
    "Get detailed information about a specific custom audience, including size estimates and lookalike specs.",
    {
      audience_id: z.string().describe("Custom audience ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ audience_id, fields }) => {
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const audience = await metaApiClient.get<CustomAudience>(
        `/${audience_id}`,
        { fields: fieldsParam },
      );

      return {
        content: [
          {
            type: "text",
            text: `Audience: ${audience.name} (${audience.id})\nType: ${audience.subtype}\nSize: ${audience.approximate_count_lower_bound ?? "?"}-${audience.approximate_count_upper_bound ?? "?"}`,
          },
          { type: "text", text: JSON.stringify(audience, null, 2) },
        ],
      };
    },
  );

  // ─── Create Custom Audience ───────────────────────────────────
  server.tool(
    "meta_ads_create_custom_audience",
    "Create a new custom audience (customer list type). Use this to create audiences from CRM data like FTDs, depositors, etc.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Audience name"),
      description: z.string().optional().describe("Audience description"),
      subtype: z
        .enum(["CUSTOM", "WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT"])
        .default("CUSTOM")
        .describe("Audience subtype"),
      customer_file_source: z
        .enum([
          "USER_PROVIDED_ONLY",
          "PARTNER_PROVIDED_ONLY",
          "BOTH_USER_AND_PARTNER_PROVIDED",
        ])
        .optional()
        .describe("Source of customer data (required for CUSTOM subtype)"),
      retention_days: z.number().optional().describe("Retention period in days"),
      rule: z.string().optional().describe("Rule definition for WEBSITE audiences (JSON string)"),
      prefill: z.boolean().optional().describe("Whether to prefill with existing data (for WEBSITE)"),
    },
    async ({ account_id, name, description, subtype, customer_file_source, retention_days, rule, prefill }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        subtype,
      };

      if (description) body.description = description;
      if (customer_file_source) body.customer_file_source = customer_file_source;
      if (retention_days !== undefined) body.retention_days = retention_days;
      if (rule) body.rule = rule;
      if (prefill !== undefined) body.prefill = prefill;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Custom audience created!\nID: ${result.id}\nName: ${name}\nType: ${subtype}`,
          },
        ],
      };
    },
  );

  // ─── Create Lookalike Audience ────────────────────────────────
  server.tool(
    "meta_ads_create_lookalike_audience",
    "Create a lookalike audience based on an existing source audience. Specify ratio (1%-20%) to control size vs. similarity tradeoff.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Lookalike audience name"),
      origin_audience_id: z.string().describe("Source custom audience ID"),
      ratio: z.number().min(0.01).max(0.20).describe("Lookalike ratio (0.01 = 1%, 0.20 = 20%)"),
      country: z.string().describe("Target country ISO code (e.g., CO, US, MX)"),
      description: z.string().optional(),
    },
    async ({ account_id, name, origin_audience_id, ratio, country, description }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        subtype: "LOOKALIKE",
        origin_audience_id,
        lookalike_spec: JSON.stringify({
          ratio,
          country,
          type: "similarity",
        }),
      };

      if (description) body.description = description;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Lookalike audience created!\nID: ${result.id}\nName: ${name}\nSource: ${origin_audience_id}\nRatio: ${(ratio * 100).toFixed(0)}%\nCountry: ${country}`,
          },
        ],
      };
    },
  );

  // ─── Delete Custom Audience ───────────────────────────────────
  server.tool(
    "meta_ads_delete_custom_audience",
    "Delete a custom audience. This action cannot be undone.",
    {
      audience_id: z.string().describe("Custom audience ID to delete"),
    },
    async ({ audience_id }) => {
      await metaApiClient.delete<{ success: boolean }>(`/${audience_id}`);

      return {
        content: [
          { type: "text", text: `Audience ${audience_id} deleted successfully.` },
        ],
      };
    },
  );
}
