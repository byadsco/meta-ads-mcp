import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import { buildFieldsParam, requireOneOf } from "../utils/validation.js";
import {
  WA_TEMPLATE_DEFAULT_FIELDS,
  type MessageTemplate,
} from "../meta/types/whatsapp.js";
import { READ, CREATE, UPDATE, DELETE, WHATSAPP_WRITE_WARNING } from "./_register.js";

const TEMPLATE_CATEGORY = z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]);
const TEMPLATE_STATUS = z.enum([
  "APPROVED", "PENDING", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL",
]);

const templateComponentSchema = z
  .record(z.string(), z.unknown())
  .describe("Template component object (type HEADER/BODY/FOOTER/BUTTONS plus its fields).");

function toUnixSeconds(value: string, label: string): number {
  if (/^\d{9,12}$/.test(value)) return parseInt(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${label}: use YYYY-MM-DD or a UNIX timestamp in seconds.`);
  }
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
}

function assertEnumTokens(values: string[], label: string): string[] {
  for (const v of values) {
    if (!/^[A-Z_]+$/.test(v)) {
      throw new Error(`Invalid ${label} value: ${JSON.stringify(v).slice(0, 40)}`);
    }
  }
  return values;
}

export function registerWhatsAppTemplateTools(server: McpServer): void {
  // ─── Get Templates ────────────────────────────────────────────
  server.registerTool(
    "whatsapp_get_templates",
    {
      description:
        "List message templates on a WhatsApp Business Account (filterable by name, status, category, language), " +
        "or get full details (including components) for a single template by ID.",
      inputSchema: {
        waba_id: z.string().optional().describe("WhatsApp Business Account ID to list templates for."),
        template_id: z.string().optional().describe("Template ID for single-template details."),
        name: z.string().optional().describe("Filter by template name (prefix match)."),
        status: TEMPLATE_STATUS.optional().describe("Filter by review status."),
        category: TEMPLATE_CATEGORY.optional().describe("Filter by category."),
        language: z.string().optional().describe("Filter by language code (e.g. en_US, es_MX)."),
        fields: z.array(z.string()).optional().describe("Fields to return per template."),
        limit: z.number().min(1).max(200).default(25).describe("Maximum templates to return."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id, template_id, name, status, category, language, fields, limit }) => {
      requireOneOf({ waba_id, template_id }, ["waba_id", "template_id"]);

      if (template_id) {
        const template = await metaApiClient.get<MessageTemplate>(
          `/${validateMetaId(template_id, "template_id")}`,
          {
            fields: buildFieldsParam(fields, [
              ...WA_TEMPLATE_DEFAULT_FIELDS,
              "components",
              "rejected_reason",
              "parameter_format",
            ]),
          },
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Template: ${template.name ?? template.id}\n` +
                `  Status: ${template.status ?? "N/A"}\n` +
                `  Category: ${template.category ?? "N/A"}\n` +
                `  Language: ${template.language ?? "N/A"}` +
                (template.rejected_reason ? `\n  Rejected reason: ${template.rejected_reason}` : ""),
            },
            { type: "text", text: JSON.stringify(template, null, 2) },
          ],
        };
      }

      const params: Record<string, string | number> = {
        fields: buildFieldsParam(fields, [...WA_TEMPLATE_DEFAULT_FIELDS]),
      };
      if (name) params.name = name;
      if (status) params.status = status;
      if (category) params.category = category;
      if (language) params.language = language;

      const templates = await metaApiClient.getPaginated<MessageTemplate>(
        `/${validateMetaId(waba_id!, "waba_id")}/message_templates`,
        params,
        limit,
      );

      if (templates.length === 0) {
        return {
          content: [
            { type: "text", text: `No message templates found on WABA ${waba_id} for the given filters.` },
            { type: "text", text: "[]" },
          ],
        };
      }

      const lines = [
        `Found ${templates.length} template(s) on WABA ${waba_id}:`,
        ``,
        ...templates.map(
          (t) =>
            `- ${t.name ?? t.id} [${t.language ?? "?"}] — ${t.status ?? "?"} / ${t.category ?? "?"} (ID: ${t.id})`,
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(templates, null, 2) },
        ],
      };
    },
  );

  // ─── Create Template ──────────────────────────────────────────
  server.registerTool(
    "whatsapp_create_template",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Create a message template on a WhatsApp Business Account. ` +
        "The template enters Meta's review queue (status PENDING). Name must be lowercase letters, " +
        "digits and underscores. AUTHENTICATION templates only accept OTP-style components. " +
        "Meta may recategorize the template unless allow_category_change is false.",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        name: z
          .string()
          .max(512)
          .regex(/^[a-z0-9_]+$/, "Name must contain only lowercase letters, digits, and underscores")
          .describe("Template name (lowercase, digits, underscores)."),
        category: TEMPLATE_CATEGORY.describe("Template category."),
        language: z
          .string()
          .regex(/^[a-z]{2}(_[A-Z]{2})?$/, "Use a locale code like en, en_US, es_MX")
          .describe("Language/locale code (e.g. en_US, es_MX)."),
        components: z
          .array(templateComponentSchema)
          .min(1)
          .describe(
            'Template components array, e.g. [{"type":"BODY","text":"Hi {{1}}"},{"type":"FOOTER","text":"Reply STOP to opt out"}].',
          ),
        allow_category_change: z
          .boolean()
          .default(true)
          .describe("Let Meta recategorize automatically instead of rejecting on category mismatch."),
        parameter_format: z
          .enum(["POSITIONAL", "NAMED"])
          .optional()
          .describe("Placeholder style: {{1}} (POSITIONAL) or {{name}} (NAMED)."),
      },
      annotations: { ...CREATE },
    },
    async ({ waba_id, name, category, language, components, allow_category_change, parameter_format }) => {
      const id = validateMetaId(waba_id, "waba_id");

      const body: Record<string, unknown> = {
        name,
        category,
        language,
        components,
        allow_category_change,
      };
      if (parameter_format) body.parameter_format = parameter_format;

      const result = await metaApiClient.post<{ id: string; status?: string; category?: string }>(
        `/${id}/message_templates`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Template "${name}" (${language}) created on WABA ${waba_id}.\n` +
              `  ID: ${result.id}\n` +
              `  Status: ${result.status ?? "PENDING"}\n` +
              `  Category: ${result.category ?? category}\n` +
              `It must pass Meta's review before it can be sent.`,
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ─── Update Template ──────────────────────────────────────────
  server.registerTool(
    "whatsapp_update_template",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Edit a message template's components, category, or message TTL. ` +
        "Only templates in APPROVED, REJECTED, or PAUSED status can be edited. APPROVED templates " +
        "can be edited at most once per 24 hours and 10 times per month; editing re-triggers review " +
        "(status returns to PENDING). Do NOT retry on an edit-limit error.",
      inputSchema: {
        template_id: z.string().describe("Template ID to edit."),
        components: z
          .array(templateComponentSchema)
          .optional()
          .describe("Replacement components array (replaces ALL components)."),
        category: TEMPLATE_CATEGORY.optional().describe("New category."),
        message_send_ttl_seconds: z
          .number()
          .int()
          .optional()
          .describe("Custom time-to-live for sent messages, in seconds."),
      },
      annotations: { ...UPDATE },
    },
    async ({ template_id, components, category, message_send_ttl_seconds }) => {
      const id = validateMetaId(template_id, "template_id");

      const body: Record<string, unknown> = {};
      if (components !== undefined) body.components = components;
      if (category !== undefined) body.category = category;
      if (message_send_ttl_seconds !== undefined) {
        body.message_send_ttl_seconds = message_send_ttl_seconds;
      }
      if (Object.keys(body).length === 0) {
        throw new Error("Provide at least one of components, category, or message_send_ttl_seconds.");
      }

      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}`, body);
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the update for template ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Template ${template_id} updated (${Object.keys(body).join(", ")}).\n` +
              `If components changed, the template re-enters review (status PENDING).\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Delete Template ──────────────────────────────────────────
  server.registerTool(
    "whatsapp_delete_template",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Delete a message template by name. Without hsm_id, ALL language ` +
        "versions of that name are deleted. Deleted template names cannot be reused for ~4 weeks " +
        "(pending deletion). Cannot be undone.",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        name: z
          .string()
          .max(512)
          .regex(/^[a-z0-9_]+$/, "Name must contain only lowercase letters, digits, and underscores")
          .describe("Template name to delete."),
        hsm_id: z
          .string()
          .optional()
          .describe("Specific template ID to delete only one language version instead of all."),
      },
      annotations: { ...DELETE },
    },
    async ({ waba_id, name, hsm_id }) => {
      const id = validateMetaId(waba_id, "waba_id");

      const params: Record<string, string> = { name };
      if (hsm_id) params.hsm_id = validateMetaId(hsm_id, "hsm_id");

      const result = await metaApiClient.delete<{ success?: boolean }>(
        `/${id}/message_templates`,
        params,
      );
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the deletion of template "${name}". Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Template "${name}" ${hsm_id ? `(version ${hsm_id})` : "(all language versions)"} ` +
              `deleted from WABA ${waba_id}.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── WABA Analytics ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_get_analytics",
    {
      description:
        "Get WhatsApp Business Account analytics: MESSAGING (messages sent/delivered), " +
        "CONVERSATION (legacy conversation counts and cost), or PRICING (per-message pricing " +
        "analytics, current model since July 2025).",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        metric_type: z
          .enum(["MESSAGING", "CONVERSATION", "PRICING"])
          .default("MESSAGING")
          .describe("Which analytics family to query."),
        start: z.string().describe("Start of range: YYYY-MM-DD or UNIX seconds."),
        end: z.string().describe("End of range: YYYY-MM-DD or UNIX seconds."),
        granularity: z
          .enum(["HALF_HOUR", "DAY", "MONTH"])
          .default("DAY")
          .describe("Aggregation granularity (mapped automatically per metric family)."),
        dimensions: z
          .array(z.string())
          .optional()
          .describe(
            "Breakdown dimensions for CONVERSATION/PRICING, e.g. CONVERSATION_CATEGORY, PRICING_CATEGORY, COUNTRY, PHONE.",
          ),
        phone_numbers: z
          .array(z.string())
          .optional()
          .describe("Filter to specific phone numbers (display format, e.g. +16505551111)."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id, metric_type, start, end, granularity, dimensions, phone_numbers }) => {
      const id = validateMetaId(waba_id, "waba_id");
      const startTs = toUnixSeconds(start, "start");
      const endTs = toUnixSeconds(end, "end");

      const fieldName =
        metric_type === "CONVERSATION"
          ? "conversation_analytics"
          : metric_type === "PRICING"
            ? "pricing_analytics"
            : "analytics";
      const gran =
        metric_type === "MESSAGING"
          ? granularity
          : granularity === "DAY"
            ? "DAILY"
            : granularity === "MONTH"
              ? "MONTHLY"
              : "HALF_HOUR";

      let field = `${fieldName}.start(${startTs}).end(${endTs}).granularity(${gran})`;
      if (phone_numbers && phone_numbers.length > 0) {
        for (const p of phone_numbers) {
          if (!/^\+?\d{5,20}$/.test(p)) {
            throw new Error(`Invalid phone number filter: ${JSON.stringify(p).slice(0, 40)}`);
          }
        }
        field += `.phone_numbers(${JSON.stringify(phone_numbers)})`;
      }
      if (dimensions && dimensions.length > 0 && metric_type !== "MESSAGING") {
        field += `.dimensions(${JSON.stringify(assertEnumTokens(dimensions, "dimension"))})`;
      }

      const result = await metaApiClient.get<Record<string, unknown>>(`/${id}`, { fields: field });
      const data = result[fieldName] ?? result;

      return {
        content: [
          { type: "text", text: `${metric_type} analytics for WABA ${waba_id} (${start} → ${end}, ${gran}):` },
          { type: "text", text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ─── Template Analytics ───────────────────────────────────────
  server.registerTool(
    "whatsapp_get_template_analytics",
    {
      description:
        "Get per-template performance analytics (sent, delivered, read, clicked) for up to 10 templates. " +
        "Window must be within the last 90 days; granularity is always DAILY. Requires template analytics " +
        "to be enabled on the WABA (is_enabled_for_insights) — if Meta returns an error saying it is " +
        "disabled, report it to the user instead of enabling it (enabling is irreversible).",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        start: z.string().describe("Start of range: YYYY-MM-DD or UNIX seconds (max 90 days back)."),
        end: z.string().describe("End of range: YYYY-MM-DD or UNIX seconds."),
        template_ids: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe("Template IDs to report on (1-10)."),
        metric_types: z
          .array(z.enum(["SENT", "DELIVERED", "READ", "CLICKED"]))
          .optional()
          .describe("Metrics to include. Defaults to all."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id, start, end, template_ids, metric_types }) => {
      const id = validateMetaId(waba_id, "waba_id");
      const ids = template_ids.map((t) => validateMetaId(t, "template_id"));

      const params: Record<string, string | number> = {
        start: toUnixSeconds(start, "start"),
        end: toUnixSeconds(end, "end"),
        granularity: "DAILY",
        template_ids: JSON.stringify(ids),
      };
      if (metric_types && metric_types.length > 0) {
        params.metric_types = JSON.stringify(metric_types);
      }

      const result = await metaApiClient.get<Record<string, unknown>>(
        `/${id}/template_analytics`,
        params,
      );

      return {
        content: [
          {
            type: "text",
            text: `Template analytics for ${ids.length} template(s) on WABA ${waba_id} (${start} → ${end}):`,
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
