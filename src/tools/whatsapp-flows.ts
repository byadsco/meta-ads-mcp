import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import { buildFieldsParam, requireOneOf } from "../utils/validation.js";
import {
  WA_FLOW_DEFAULT_FIELDS,
  type WhatsAppFlow,
} from "../meta/types/whatsapp.js";
import { READ, CREATE, UPDATE, TOGGLE, DELETE, WHATSAPP_WRITE_WARNING } from "./_register.js";

const FLOW_CATEGORY = z.enum([
  "SIGN_UP", "SIGN_IN", "APPOINTMENT_BOOKING", "LEAD_GENERATION",
  "CONTACT_US", "CUSTOMER_SUPPORT", "SURVEY", "OTHER",
]);

const FLOW_DETAIL_FIELDS = [
  "id",
  "name",
  "status",
  "categories",
  "validation_errors",
  "json_version",
  "data_api_version",
  "endpoint_uri",
  "preview.invalidate(false)",
  "whatsapp_business_account",
  "application",
].join(",");

function formatValidationErrors(errors: WhatsAppFlow["validation_errors"]): string {
  if (!errors || errors.length === 0) return "";
  return `\n  Validation errors:\n${JSON.stringify(errors, null, 2)}`;
}

async function uploadFlowJson(
  flowId: string,
  flowJson: string,
): Promise<{ success?: boolean; validation_errors?: Record<string, unknown>[] }> {
  const formData = new FormData();
  formData.set("file", new Blob([flowJson], { type: "application/json" }), "flow.json");
  formData.set("name", "flow.json");
  formData.set("asset_type", "FLOW_JSON");
  return metaApiClient.postMultipart(`/${flowId}/assets`, formData);
}

export function registerWhatsAppFlowTools(server: McpServer): void {
  // ─── Get Flows ────────────────────────────────────────────────
  server.registerTool(
    "whatsapp_get_flows",
    {
      description:
        "List WhatsApp Flows on a WhatsApp Business Account, or get full details for one flow " +
        "(including validation errors and a web preview URL).",
      inputSchema: {
        waba_id: z.string().optional().describe("WhatsApp Business Account ID to list flows for."),
        flow_id: z.string().optional().describe("Flow ID for single-flow details."),
        fields: z.array(z.string()).optional().describe("Fields to return per flow."),
        limit: z.number().min(1).max(100).default(25).describe("Maximum flows to return."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id, flow_id, fields, limit }) => {
      requireOneOf({ waba_id, flow_id }, ["waba_id", "flow_id"]);

      if (flow_id) {
        const flow = await metaApiClient.get<WhatsAppFlow>(
          `/${validateMetaId(flow_id, "flow_id")}`,
          { fields: fields && fields.length > 0 ? fields.join(",") : FLOW_DETAIL_FIELDS },
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Flow: ${flow.name ?? flow.id}\n` +
                `  Status: ${flow.status ?? "N/A"}\n` +
                `  Categories: ${flow.categories?.join(", ") ?? "N/A"}\n` +
                `  Preview: ${flow.preview?.preview_url ?? "N/A"}` +
                formatValidationErrors(flow.validation_errors),
            },
            { type: "text", text: JSON.stringify(flow, null, 2) },
          ],
        };
      }

      const flows = await metaApiClient.getPaginated<WhatsAppFlow>(
        `/${validateMetaId(waba_id!, "waba_id")}/flows`,
        { fields: buildFieldsParam(fields, [...WA_FLOW_DEFAULT_FIELDS]) },
        limit,
      );

      if (flows.length === 0) {
        return {
          content: [
            { type: "text", text: `No flows found on WABA ${waba_id}.` },
            { type: "text", text: "[]" },
          ],
        };
      }

      const lines = [
        `Found ${flows.length} flow(s) on WABA ${waba_id}:`,
        ``,
        ...flows.map(
          (f) =>
            `- ${f.name ?? f.id} — ${f.status ?? "?"} (ID: ${f.id})` +
            `${f.validation_errors && f.validation_errors.length > 0 ? " ⚠ has validation errors" : ""}`,
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(flows, null, 2) },
        ],
      };
    },
  );

  // ─── Create Flow ──────────────────────────────────────────────
  server.registerTool(
    "whatsapp_create_flow",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Create a WhatsApp Flow (draft). Optionally provide flow_json to set ` +
        "the flow content in the same call, clone_flow_id to copy an existing flow, or publish=true " +
        "to publish immediately (only works if the flow has no validation errors).",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        name: z.string().min(1).max(200).describe("Flow name."),
        categories: z
          .array(FLOW_CATEGORY)
          .min(1)
          .describe("Flow categories (at least one)."),
        flow_json: z
          .string()
          .optional()
          .describe("Stringified Flow JSON defining the screens and logic."),
        clone_flow_id: z.string().optional().describe("Existing flow ID to clone content from."),
        endpoint_uri: z
          .string()
          .url()
          .optional()
          .describe("Data endpoint URL for dynamic flows (Flow JSON 3.0+)."),
        publish: z
          .boolean()
          .optional()
          .describe("Publish immediately after creation (requires valid flow_json)."),
      },
      annotations: { ...CREATE },
    },
    async ({ waba_id, name, categories, flow_json, clone_flow_id, endpoint_uri, publish }) => {
      const id = validateMetaId(waba_id, "waba_id");

      const body: Record<string, unknown> = { name, categories };
      if (flow_json !== undefined) body.flow_json = flow_json;
      if (clone_flow_id !== undefined) body.clone_flow_id = validateMetaId(clone_flow_id, "flow_id");
      if (endpoint_uri !== undefined) body.endpoint_uri = endpoint_uri;
      if (publish !== undefined) body.publish = publish;

      const result = await metaApiClient.post<{
        id: string;
        success?: boolean;
        validation_errors?: Record<string, unknown>[];
      }>(`/${id}/flows`, body);

      return {
        content: [
          {
            type: "text",
            text:
              `Flow "${name}" created on WABA ${waba_id}.\n  ID: ${result.id}` +
              formatValidationErrors(result.validation_errors),
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ─── Update Flow ──────────────────────────────────────────────
  server.registerTool(
    "whatsapp_update_flow",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Update a flow's metadata (name, categories, endpoint) and/or replace ` +
        "its Flow JSON content. Content updates only apply to DRAFT flows — published flows must be " +
        "cloned first. Always check validation_errors in the response before publishing.",
      inputSchema: {
        flow_id: z.string().describe("Flow ID to update."),
        name: z.string().min(1).max(200).optional().describe("New flow name."),
        categories: z.array(FLOW_CATEGORY).min(1).optional().describe("New categories."),
        endpoint_uri: z.string().url().optional().describe("New data endpoint URL."),
        flow_json: z
          .string()
          .optional()
          .describe("Stringified Flow JSON to replace the flow content."),
      },
      annotations: { ...UPDATE },
    },
    async ({ flow_id, name, categories, endpoint_uri, flow_json }) => {
      const id = validateMetaId(flow_id, "flow_id");

      const metadata: Record<string, unknown> = {};
      if (name !== undefined) metadata.name = name;
      if (categories !== undefined) metadata.categories = categories;
      if (endpoint_uri !== undefined) metadata.endpoint_uri = endpoint_uri;

      if (Object.keys(metadata).length === 0 && flow_json === undefined) {
        throw new Error("Provide at least one of name, categories, endpoint_uri, or flow_json.");
      }

      const results: Record<string, unknown> = {};
      if (Object.keys(metadata).length > 0) {
        const metadataResult = await metaApiClient.post<{ success?: boolean }>(`/${id}`, metadata);
        if (metadataResult?.success !== true) {
          throw new Error(
            `Meta did not confirm the metadata update for flow ${id}. Response: ${JSON.stringify(metadataResult)}`,
          );
        }
        results.metadata = metadataResult;
      }
      let validationErrors: Record<string, unknown>[] | undefined;
      if (flow_json !== undefined) {
        const assetResult = await uploadFlowJson(id, flow_json);
        if (assetResult?.success !== true) {
          throw new Error(
            `Meta did not confirm the Flow JSON upload for flow ${id}. Response: ${JSON.stringify(assetResult)}`,
          );
        }
        results.flow_json = assetResult;
        validationErrors = assetResult.validation_errors;
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Flow ${flow_id} updated` +
              `${Object.keys(metadata).length > 0 ? ` (metadata: ${Object.keys(metadata).join(", ")})` : ""}` +
              `${flow_json !== undefined ? " (flow content replaced)" : ""}.` +
              formatValidationErrors(validationErrors),
          },
          { type: "text", text: JSON.stringify(results, null, 2) },
        ],
      };
    },
  );

  // ─── Publish Flow ─────────────────────────────────────────────
  server.registerTool(
    "whatsapp_publish_flow",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Publish a DRAFT flow so it can be sent to users. Fails if the flow ` +
        "has validation errors (check with whatsapp_get_flows first). Published flows cannot be " +
        "edited — only cloned or deprecated.",
      inputSchema: {
        flow_id: z.string().describe("Flow ID to publish."),
      },
      annotations: { ...TOGGLE },
    },
    async ({ flow_id }) => {
      const id = validateMetaId(flow_id, "flow_id");
      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/publish`, {});
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the publish for flow ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          { type: "text", text: `Flow ${flow_id} published.\n${JSON.stringify(result)}` },
        ],
      };
    },
  );

  // ─── Deprecate Flow ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_deprecate_flow",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Deprecate a PUBLISHED flow. IRREVERSIBLE — a deprecated flow can ` +
        "never be reactivated; users who open it see an error. Only use when the flow is retired for good.",
      inputSchema: {
        flow_id: z.string().describe("Flow ID to deprecate."),
      },
      annotations: { ...DELETE },
    },
    async ({ flow_id }) => {
      const id = validateMetaId(flow_id, "flow_id");
      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/deprecate`, {});
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the deprecation for flow ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Flow ${flow_id} deprecated (irreversible).\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Delete Flow ──────────────────────────────────────────────
  server.registerTool(
    "whatsapp_delete_flow",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Delete a flow. Only DRAFT flows can be deleted — published flows ` +
        "must be deprecated instead. Cannot be undone.",
      inputSchema: {
        flow_id: z.string().describe("Flow ID to delete (must be in DRAFT status)."),
      },
      annotations: { ...DELETE },
    },
    async ({ flow_id }) => {
      const id = validateMetaId(flow_id, "flow_id");
      const result = await metaApiClient.delete<{ success?: boolean }>(`/${id}`);
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the deletion for flow ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          { type: "text", text: `Flow ${flow_id} deleted.\n${JSON.stringify(result)}` },
        ],
      };
    },
  );
}
