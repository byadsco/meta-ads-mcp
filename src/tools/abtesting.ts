import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { STUDY_DEFAULT_FIELDS } from "../meta/types/study.js";
import type { AdStudy, MetaApiResponse } from "../meta/types/index.js";

export function registerABTestingTools(server: McpServer): void {
  // ─── Get Ad Studies ───────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_studies",
    "List A/B test studies (split tests) for an ad account.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...STUDY_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<AdStudy>>(
        `/${id}/ad_studies`,
        { fields: fieldsParam, limit },
      );
      const studies = response.data ?? [];

      const text =
        studies.length === 0
          ? "No A/B test studies found."
          : studies
              .map(
                (s) =>
                  `• ${s.name} (${s.id}) — Type: ${s.type ?? "N/A"} — Confidence: ${s.confidence_level ?? "N/A"}%`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${studies.length} study/studies:\n\n${text}` },
          { type: "text", text: JSON.stringify(studies, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Study ──────────────────────────────────────────
  server.tool(
    "meta_ads_create_ad_study",
    "Create an A/B test (split test) to compare ad variations with statistical significance. Supports testing creative, audience, placement, and delivery optimization variables.",
    {
      account_id: z.string().describe("Ad account ID"),
      name: z.string().min(1).describe("Study name"),
      description: z.string().optional(),
      start_time: z.string().describe("Start time (ISO 8601, e.g., 2025-01-15T00:00:00-0500)"),
      end_time: z.string().describe("End time (ISO 8601)"),
      type: z
        .enum(["SPLIT_TEST", "LIFT_STUDY"])
        .default("SPLIT_TEST"),
      cells: z
        .array(
          z.object({
            name: z.string().describe("Cell/variant name"),
            treatment_percentage: z.number().min(1).max(100).describe("Traffic percentage for this cell"),
            adsets: z.array(z.string()).optional().describe("Ad set IDs for this cell"),
            campaigns: z.array(z.string()).optional().describe("Campaign IDs for this cell"),
          }),
        )
        .describe("Test cells/variants — each gets a portion of the traffic"),
      objectives: z
        .array(
          z.object({
            type: z.string().describe("Objective type (e.g., CONVERSIONS, LEADS)"),
            name: z.string().describe("Objective display name"),
          }),
        )
        .optional()
        .describe("Study objectives to measure"),
      confidence_level: z
        .number()
        .min(80)
        .max(99)
        .default(95)
        .describe("Required confidence level (%)"),
    },
    async ({ account_id, name, description, start_time, end_time, type, cells, objectives, confidence_level }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        type,
        start_time,
        end_time,
        confidence_level,
        cells: JSON.stringify(
          cells.map((c) => ({
            name: c.name,
            treatment_percentage: c.treatment_percentage,
            adsets: c.adsets?.map((id) => ({ id })),
            campaigns: c.campaigns?.map((id) => ({ id })),
          })),
        ),
      };

      if (description) body.description = description;
      if (objectives) body.objectives = JSON.stringify(objectives);

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/ad_studies`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `A/B test study created!\nID: ${result.id}\nName: ${name}\nType: ${type}\nCells: ${cells.length}\nConfidence: ${confidence_level}%`,
          },
        ],
      };
    },
  );

  // ─── Get Study Details & Results ──────────────────────────────
  server.tool(
    "meta_ads_get_study_details",
    "Get detailed information and results of an A/B test study, including per-cell performance and statistical significance.",
    {
      study_id: z.string().describe("Study ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ study_id, fields }) => {
      const allFields = [
        ...STUDY_DEFAULT_FIELDS,
        "cells{id,name,treatment_percentage,campaigns,adsets}",
        "objectives",
      ];
      const fieldsParam = buildFieldsParam(fields, allFields);

      const study = await metaApiClient.get<AdStudy>(
        `/${study_id}`,
        { fields: fieldsParam },
      );

      const lines: string[] = [
        `Study: ${study.name} (${study.id})`,
        `Type: ${study.type ?? "N/A"}`,
        `Period: ${study.start_time ?? "?"} → ${study.end_time ?? "?"}`,
        `Confidence Level: ${study.confidence_level ?? "N/A"}%`,
      ];

      if (study.cells && study.cells.length > 0) {
        lines.push(`\nCells (${study.cells.length}):`);
        for (const cell of study.cells) {
          lines.push(
            `  • ${cell.name} (${cell.id}) — Traffic: ${cell.treatment_percentage ?? "?"}%`,
          );
        }
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(study, null, 2) },
        ],
      };
    },
  );
}
