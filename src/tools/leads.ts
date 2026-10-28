import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { withPageToken } from "../meta/page-token.js";
import { buildFieldsParam } from "../utils/validation.js";
import { truncateResponse, validateMetaId } from "../utils/format.js";
import { LEAD_FORM_DEFAULT_FIELDS, LEAD_DEFAULT_FIELDS } from "../meta/types/lead.js";
import type { LeadForm, Lead, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, WRITE_WARNING } from "./_register.js";

const LEAD_FORM_FIELDS = [
  ...LEAD_FORM_DEFAULT_FIELDS,
  "expired_leads_count",
  "organic_leads_count",
  "context_card",
  "thank_you_page",
  "legal_content",
  "tracking_parameters",
  "is_optimized_for_quality",
  "block_display_for_non_targeted_viewer",
  "question_page_custom_headline",
  "privacy_policy_url",
  "page_id",
  "allow_organic_lead",
  "follow_up_action_text",
] as const;

export function registerLeadTools(server: McpServer): void {
  // ─── Get Lead Forms ───────────────────────────────────────────
  server.registerTool(
    "ads_get_lead_forms",
    {
      description:
        "List lead generation forms for a Facebook Page. Returns form details including questions, status, and lead count. Meta answers only to a Page token: the server gets one with the person's token for this call only and never shows or stores it.",
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.enum(LEAD_FORM_FIELDS)).optional().describe("Fields to retrieve, among the lead form's own"),
      },
      annotations: { ...READ },
    },
    async ({ page_id, limit, fields }) => {
      const id = validateMetaId(page_id, "page");
      // The call runs with the Page token, so it may name only the form's own
      // fields: an expansion such as page{access_token} would hand it back.
      const badField = (fields ?? []).findIndex((field) => !(LEAD_FORM_FIELDS as readonly string[]).includes(field));
      if (badField !== -1) throw new Error(`fields[${badField}] is not one of the lead form fields this tool reads: ${LEAD_FORM_FIELDS.join(", ")}.`);
      const fieldsParam = buildFieldsParam(fields, [...LEAD_FORM_DEFAULT_FIELDS]);

      // Meta answers this only to a Page token (#190 with the person's own).
      const response = await withPageToken(id, () => metaApiClient.get<MetaApiResponse<LeadForm>>(
        `/${id}/leadgen_forms`,
        { fields: fieldsParam, limit },
      ));
      const forms = response.data ?? [];

      const text =
        forms.length === 0
          ? "No lead forms found."
          : forms
              .map(
                (f) =>
                  `• ${f.name} (${f.id}) — Status: ${f.status} — Leads: ${f.leads_count ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${forms.length} lead form(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(forms, null, 2) },
        ],
      };
    },
  );

  // ─── Get Leads from Form ──────────────────────────────────────
  server.registerTool(
    "ads_get_leads",
    {
      description:
        "Download leads from a lead generation form. Returns lead data including field values, timestamps, and associated ad/campaign info.",
      inputSchema: {
        form_id: z.string().describe("Lead form ID"),
        limit: z.number().min(1).max(500).default(100),
        fields: z.array(z.string()).optional().describe("Fields to retrieve"),
        filtering: z
          .array(
            z.object({
              field: z.string(),
              operator: z.string(),
              value: z.union([z.string(), z.number()]),
            }),
          )
          .optional()
          .describe("Filter leads (e.g., by time_created)"),
      },
      annotations: { ...READ },
    },
    async ({ form_id, limit, fields, filtering }) => {
      const id = validateMetaId(form_id, "lead_form");
      const fieldsParam = buildFieldsParam(fields, [...LEAD_DEFAULT_FIELDS]);

      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (filtering && filtering.length > 0) {
        params.filtering = JSON.stringify(filtering);
      }

      const response = await metaApiClient.get<MetaApiResponse<Lead>>(
        `/${id}/leads`,
        params,
      );
      const leads = response.data ?? [];

      if (leads.length === 0) {
        return {
          content: [{ type: "text", text: "No leads found for this form." }],
        };
      }

      const summary = leads
        .slice(0, 10)
        .map((l) => {
          const fieldSummary = l.field_data
            .map((f) => `${f.name}: ${f.values.join(", ")}`)
            .join(" | ");
          return `• ${l.id} (${l.created_time}) — ${fieldSummary}`;
        })
        .join("\n");

      const jsonStr = truncateResponse(JSON.stringify(leads, null, 2));

      return {
        content: [
          {
            type: "text",
            text: `Found ${leads.length} lead(s)${leads.length > 10 ? ` (showing first 10 in summary)` : ""}:\n\n${summary}`,
          },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );

  // ─── Get Leads from Ad ────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_leads",
    {
      description:
        "Get leads generated by a specific ad. Useful for analyzing lead quality per ad variant.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID"),
        limit: z.number().min(1).max(500).default(100),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, limit, fields }) => {
      const id = validateMetaId(ad_id, "ad");
      const fieldsParam = buildFieldsParam(fields, [...LEAD_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<Lead>>(
        `/${id}/leads`,
        { fields: fieldsParam, limit },
      );
      const leads = response.data ?? [];

      if (leads.length === 0) {
        return {
          content: [{ type: "text", text: `No leads found for ad ${id}.` }],
        };
      }

      const jsonStr = truncateResponse(JSON.stringify(leads, null, 2));

      return {
        content: [
          { type: "text", text: `Found ${leads.length} lead(s) for ad ${id}.` },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );

  // ─── Create Lead Form ─────────────────────────────────────────
  server.registerTool(
    "ads_create_lead_form",
    {
      description: `${WRITE_WARNING}Create a lead generation form on a Facebook Page, to open from a lead ad (ads_create_ad_creative with destination lead_form). Questions can be prefilled ones (FULL_NAME, EMAIL, PHONE, …) or CUSTOM, as free text or multiple choice (options). Optional intro card (context_card) and thank-you screen (thank_you_page). Meta requires a Page token for forms: the server gets one with the person's token for this call only and never shows or stores it; the person has to manage the Page (pages_manage_ads).`,
      inputSchema: {
        page_id: z.string().describe("Facebook Page ID"),
        name: z.string().min(1).describe("Form name"),
        questions: z
          .array(
            z.object({
              type: z.string().describe("Question type (e.g., FULL_NAME, EMAIL, PHONE, CITY, CUSTOM). Meta names the phone question PHONE"),
              key: z.string().optional().describe("Custom question key"),
              label: z.string().optional().describe("Custom question label"),
              options: z.array(z.object({
                value: z.string().min(1).describe("Answer shown"),
                key: z.string().min(1).describe("Answer key in the lead data; Meta fails without one"),
              })).min(2).max(20).optional().describe("Answers for a CUSTOM multiple-choice question"),
            }),
          )
          .min(1)
          .describe("Form questions"),
        privacy_policy_url: z.string().describe("Privacy policy URL (required by Meta)"),
        privacy_policy_link_text: z.string().min(1).optional().describe("Text of the privacy policy link"),
        context_card: z.object({
          title: z.string().min(1).optional(),
          content: z.array(z.string().min(1)).min(1).describe("Paragraphs, or list items with style LIST_STYLE"),
          style: z.enum(["PARAGRAPH_STYLE", "LIST_STYLE"]).default("PARAGRAPH_STYLE"),
          button_text: z.string().min(1).optional(),
        }).optional().describe("Intro card shown before the questions"),
        thank_you_page: z.object({
          title: z.string().min(1),
          body: z.string().min(1),
          button_type: z.string().regex(/^[A-Z_]+$/).describe("e.g. VIEW_WEBSITE, CALL_BUSINESS, DOWNLOAD"),
          button_text: z.string().min(1).optional(),
          website_url: z.string().optional().describe("For VIEW_WEBSITE and DOWNLOAD"),
          business_phone_number: z.string().optional().describe("For CALL_BUSINESS, international format"),
        }).optional().describe("Screen shown after the form is sent"),
        follow_up_action_url: z.string().optional().describe("Thank you page URL"),
        locale: z.string().optional().describe("Form locale (e.g., en_US, es_LA)"),
      },
      annotations: { ...CREATE },
    },
    async ({ page_id, name, questions, privacy_policy_url, privacy_policy_link_text, context_card, thank_you_page, follow_up_action_url, locale }) => {
      const id = validateMetaId(page_id, "page");
      const badOptions = questions.findIndex((q) => q.options && q.type !== "CUSTOM");
      if (badOptions !== -1) throw new Error(`questions[${badOptions}] has options: only CUSTOM questions take multiple-choice answers.`);
      if (!thank_you_page && !follow_up_action_url) {
        throw new Error("Give thank_you_page or follow_up_action_url: Meta requires a place to send people after the form (subcode 1892085).");
      }
      const body: Record<string, string | number | boolean> = {
        name,
        questions: JSON.stringify(questions),
        privacy_policy: JSON.stringify(privacy_policy_link_text ? { url: privacy_policy_url, link_text: privacy_policy_link_text } : { url: privacy_policy_url }),
      };

      if (context_card) body.context_card = JSON.stringify(context_card);
      if (thank_you_page) body.thank_you_page = JSON.stringify(thank_you_page);
      if (follow_up_action_url) body.follow_up_action_url = follow_up_action_url;
      if (locale) body.locale = locale;

      const result = await withPageToken(id, () => metaApiClient.postForm<{ id: string }>(
        `/${id}/leadgen_forms`,
        body,
      ));

      return {
        content: [
          {
            type: "text",
            text: `Lead form created successfully!\nID: ${result.id}\nName: ${name}\nQuestions: ${questions.length}\nPage: ${id}`,
          },
        ],
      };
    },
  );
}
