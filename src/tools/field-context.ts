import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MINOR_UNIT_NOTE } from "../meta/currency.js";
import { bidStrategyEnum, objectiveEnum, specialAdCategoryEnum } from "./campaigns.js";
import { billingEventEnum, destinationTypeEnum, optimizationGoalEnum } from "./adsets.js";
import { READ } from "./_register.js";

type Level = "campaign" | "ad_set" | "ad";

interface FieldInfo {
  type: string;
  /** The levels whose objects have the field (measured on a node of each). */
  levels: readonly Level[];
  /**
   * The operator Meta applies at each level, measured by filtering for an
   * impossible value and getting nothing back; "no" where the field exists
   * but Meta refused the filter. A level left out was not measured.
   */
  filter?: Partial<Record<Level, string>>;
  /**
   * Allowed values: the ones Meta listed, on valuesLevels, when that is set;
   * otherwise the ones this server's create tools accept.
   */
  values?: readonly string[];
  valuesLevels?: readonly Level[];
  note?: string;
}

const ALL: readonly Level[] = ["campaign", "ad_set", "ad"];
const CAMPAIGN_ADSET: readonly Level[] = ["campaign", "ad_set"];
const EVERYWHERE = (operator: string): Partial<Record<Level, string>> => ({ campaign: operator, ad_set: operator, ad: operator });
const TIME_NOTE = "ISO 8601 when read; filter with Unix seconds (e.g. GREATER_THAN 1793600000)";
const STATUS_VALUES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"] as const;
// Listed by Meta for campaigns and ad sets when given a value it does not know;
// for ads it answers with subcode 1487176 and no list.
const EFFECTIVE_STATUS_VALUES = [
  "ACTIVE", "PAUSED", "DELETED", "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED", "ARCHIVED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES",
] as const;

// Measured on Marketing API v26.0 against a test ad account, 2026-10-28.
export const FIELD_CONTEXT: Record<string, FieldInfo> = {
  id: { type: "id", levels: ALL, filter: EVERYWHERE("IN") },
  name: { type: "text", levels: ALL, filter: EVERYWHERE("CONTAIN") },
  account_id: { type: "id", levels: ALL },
  campaign_id: { type: "id", levels: ["ad_set", "ad"], note: "to filter by campaign use campaign.id" },
  adset_id: { type: "id", levels: ["ad"], note: "to filter by ad set use adset.id" },
  "campaign.id": { type: "filter path (id)", levels: [], filter: { ad_set: "IN", ad: "IN" }, note: "ad sets or ads of these campaigns" },
  "adset.id": { type: "filter path (id)", levels: [], filter: { campaign: "IN", ad: "IN" }, note: "campaigns holding these ad sets, or ads in them" },
  "campaign.objective": { type: "filter path (enum)", levels: [], filter: { ad_set: "IN" }, values: objectiveEnum.options, note: "ad sets whose campaign has these objectives" },
  status: { type: "enum", levels: ALL, filter: { campaign: "IN" }, values: STATUS_VALUES, note: "the status set on the object itself" },
  configured_status: { type: "enum", levels: ALL, filter: { campaign: "no" }, values: STATUS_VALUES },
  effective_status: {
    type: "enum",
    levels: ALL,
    filter: EVERYWHERE("IN"),
    values: EFFECTIVE_STATUS_VALUES,
    valuesLevels: CAMPAIGN_ADSET,
    note: "the status Meta delivers with, after the parents' status and review",
  },
  objective: { type: "enum", levels: ["campaign"], filter: { campaign: "IN" }, values: objectiveEnum.options },
  buying_type: { type: "enum", levels: ["campaign"], filter: { campaign: "IN" }, values: ["AUCTION", "RESERVED"] },
  bid_strategy: { type: "enum", levels: CAMPAIGN_ADSET, filter: { campaign: "IN" }, values: bidStrategyEnum.options },
  special_ad_categories: { type: "list of enum", levels: ["campaign"], filter: { campaign: "no" }, values: specialAdCategoryEnum.options, note: "NONE is read back as an empty list" },
  special_ad_category_country: { type: "list of country codes", levels: ["campaign"] },
  daily_budget: { type: "integer", levels: CAMPAIGN_ADSET, filter: { campaign: "GREATER_THAN", ad_set: "GREATER_THAN" }, note: MINOR_UNIT_NOTE },
  lifetime_budget: { type: "integer", levels: CAMPAIGN_ADSET, filter: { campaign: "GREATER_THAN" }, note: MINOR_UNIT_NOTE },
  budget_remaining: { type: "integer", levels: CAMPAIGN_ADSET, filter: { campaign: "no" }, note: MINOR_UNIT_NOTE },
  spend_cap: {
    type: "integer",
    levels: ["campaign"],
    filter: { campaign: "GREATER_THAN" },
    note: `the campaign's lifetime cap, ${MINOR_UNIT_NOTE}; not the account spend cap, which is in whole currency`,
  },
  bid_amount: { type: "integer", levels: ["ad_set", "ad"], note: MINOR_UNIT_NOTE },
  is_adset_budget_sharing_enabled: { type: "boolean", levels: ["campaign"] },
  start_time: { type: "datetime", levels: CAMPAIGN_ADSET, filter: { campaign: "GREATER_THAN" }, note: TIME_NOTE },
  stop_time: { type: "datetime", levels: ["campaign"], filter: { campaign: "GREATER_THAN" }, note: TIME_NOTE },
  end_time: { type: "datetime", levels: ["ad_set"], note: TIME_NOTE },
  created_time: { type: "datetime", levels: ALL, filter: EVERYWHERE("GREATER_THAN"), note: TIME_NOTE },
  updated_time: { type: "datetime", levels: ALL, filter: EVERYWHERE("GREATER_THAN"), note: TIME_NOTE },
  optimization_goal: { type: "enum", levels: ["ad_set"], filter: { ad_set: "IN" }, values: optimizationGoalEnum.options },
  billing_event: { type: "enum", levels: ["ad_set"], values: billingEventEnum.options },
  destination_type: { type: "enum", levels: ["ad_set"], values: destinationTypeEnum.options },
  is_dynamic_creative: { type: "boolean", levels: ["ad_set"] },
  targeting: { type: "object", levels: ["ad_set"], note: "see ads_get_targeting_description" },
  promoted_object: { type: "object", levels: ["ad_set"] },
  attribution_spec: { type: "list of objects", levels: ["ad_set"] },
  frequency_control_specs: { type: "list of objects", levels: ["ad_set"] },
  dsa_beneficiary: { type: "text", levels: ["ad_set"] },
  dsa_payor: { type: "text", levels: ["ad_set"] },
  creative: { type: "object", levels: ["ad"], note: "request creative{id} or creative{id,name}" },
  conversion_domain: { type: "text", levels: ["ad"] },
  tracking_specs: { type: "list of objects", levels: ["ad"] },
  issues_info: { type: "list of objects", levels: ALL },
  ad_review_feedback: { type: "object", levels: ["ad"] },
};

const LEVEL_LABEL: Record<Level, string> = { campaign: "campaign", ad_set: "ad set", ad: "ad" };

function line(name: string, info: FieldInfo, only?: Level): string {
  const levels = (only ? info.levels.filter((l) => l === only) : info.levels).map((l) => LEVEL_LABEL[l]);
  const filters = Object.entries(info.filter ?? {})
    .filter(([level]) => !only || level === only)
    .map(([level, op]) => (op === "no" ? `no filter on ${LEVEL_LABEL[level as Level]}` : `filter on ${LEVEL_LABEL[level as Level]}: ${op}`));
  return [
    `• ${name} — ${info.type}`,
    ...(levels.length ? [`on ${levels.join(", ")}`] : []),
    ...filters,
    ...valuesPart(info, only),
    ...(info.note ? [info.note] : []),
  ].join(" — ");
}

function valuesPart(info: FieldInfo, only?: Level): string[] {
  if (!info.values) return [];
  if (!info.valuesLevels) return [`values this server's create tools accept: ${info.values.join(", ")}`];
  if (only && !info.valuesLevels.includes(only)) return [`Meta lists no values for ${LEVEL_LABEL[only]}s`];
  const where = info.valuesLevels.map((l) => `${LEVEL_LABEL[l]}s`).join(" and ");
  return [`values listed by Meta for ${where}: ${info.values.join(", ")}`];
}

export function registerFieldContextTools(server: McpServer): void {
  server.registerTool(
    "ads_get_field_context",
    {
      description:
        "Look up campaign, ad set and ad fields before calling ads_get_ad_entities: each field's type, the levels that have it, " +
        "whether Meta filters on it at a level and with which operator, its allowed values, and its unit. " +
        "Measured against Meta's API, not taken from documentation; a level whose filter was not measured is not listed. No call to Meta.",
      inputSchema: {
        entity_type: z.enum(["campaign", "ad_set", "ad"]).optional().describe("Only the fields of this level"),
        fields: z.array(z.string().max(80)).min(1).max(50).optional().describe("Only these fields"),
      },
      annotations: { ...READ },
    },
    async ({ entity_type, fields }) => {
      const names = fields ?? Object.keys(FIELD_CONTEXT);
      const known = names.filter((n) => Object.hasOwn(FIELD_CONTEXT, n));
      const unknown = names.filter((n) => !Object.hasOwn(FIELD_CONTEXT, n));
      const shown = known.filter((n) => {
        const info = FIELD_CONTEXT[n];
        return !entity_type || info.levels.includes(entity_type) || Object.hasOwn(info.filter ?? {}, entity_type);
      });
      const lines = [
        `Field context for ${entity_type ? LEVEL_LABEL[entity_type] + "s" : "campaigns, ad sets and ads"} (Marketing API v26.0). ` +
          "Pass filters to ads_get_ad_entities as filtering: [{field, operator, value}].",
        ...shown.map((n) => line(n, FIELD_CONTEXT[n], entity_type)),
        ...(unknown.length ? [`Not in this table: ${unknown.map((n) => JSON.stringify(n).slice(1, -1).slice(0, 80)).join(", ")}. Meta may still have it.`] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
