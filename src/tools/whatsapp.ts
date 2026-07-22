import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import { buildFieldsParam, requireOneOf } from "../utils/validation.js";
import {
  WABA_DEFAULT_FIELDS,
  WA_PHONE_DEFAULT_FIELDS,
  WA_PROFILE_FIELDS,
  type WhatsAppBusinessAccount,
  type WhatsAppPhoneNumber,
  type WhatsAppBusinessProfile,
} from "../meta/types/whatsapp.js";
import { READ, CREATE, UPDATE, TOGGLE, WHATSAPP_WRITE_WARNING } from "./_register.js";

const MAX_BUSINESSES_TO_SCAN = 10;

const BUSINESS_VERTICAL = z.enum([
  "UNDEFINED", "OTHER", "AUTO", "BEAUTY", "APPAREL", "EDU", "ENTERTAIN",
  "EVENT_PLAN", "FINANCE", "GROCERY", "GOVT", "HOTEL", "HEALTH", "NONPROFIT",
  "PROF_SERVICES", "RETAIL", "TRAVEL", "RESTAURANT", "NOT_A_BIZ",
]);

const PERMISSION_HINT =
  "If Meta returns a permission error (code 200/10), the access token was issued " +
  "without the whatsapp_business_management scope — re-authorize via the OAuth flow " +
  "to grant WhatsApp permissions.";

interface WabaWithSource extends WhatsAppBusinessAccount {
  _source?: string;
}

export function registerWhatsAppTools(server: McpServer): void {
  // ─── Get Business Accounts (WABAs) ────────────────────────────
  server.registerTool(
    "whatsapp_get_business_accounts",
    {
      description:
        "List WhatsApp Business Accounts (WABAs) owned by or shared with a business, or get details for one WABA. " +
        "Without business_id, discovers WABAs across the businesses the token can access. " +
        `Use this first to find the waba_id required by the other whatsapp_* tools. ${PERMISSION_HINT}`,
      inputSchema: {
        business_id: z
          .string()
          .optional()
          .describe("Business ID to list WABAs for. Omit to scan all accessible businesses."),
        waba_id: z
          .string()
          .optional()
          .describe("WhatsApp Business Account ID. Provide to fetch details for a single WABA."),
        include_client_wabas: z
          .boolean()
          .default(true)
          .describe("Also list WABAs shared with the business by clients (client_whatsapp_business_accounts)."),
        fields: z.array(z.string()).optional().describe("Fields to return per WABA."),
        limit: z.number().min(1).max(100).default(25).describe("Maximum WABAs to return."),
      },
      annotations: { ...READ },
    },
    async ({ business_id, waba_id, include_client_wabas, fields, limit }) => {
      const fieldsParam = buildFieldsParam(fields, [...WABA_DEFAULT_FIELDS]);

      if (waba_id) {
        const waba = await metaApiClient.get<WhatsAppBusinessAccount>(
          `/${validateMetaId(waba_id, "waba_id")}`,
          { fields: `${fieldsParam},health_status` },
        );
        return {
          content: [
            {
              type: "text",
              text:
                `WABA: ${waba.name ?? waba.id}\n` +
                `  ID: ${waba.id}\n` +
                `  Review status: ${waba.account_review_status ?? "N/A"}\n` +
                `  Verification: ${waba.business_verification_status ?? "N/A"}\n` +
                `  Template namespace: ${waba.message_template_namespace ?? "N/A"}`,
            },
            { type: "text", text: JSON.stringify(waba, null, 2) },
          ],
        };
      }

      let businessIds: { id: string; name?: string }[];
      if (business_id) {
        businessIds = [{ id: validateMetaId(business_id, "business_id") }];
      } else {
        const businesses = await metaApiClient.getPaginated<{ id: string; name?: string }>(
          "/me/businesses",
          { fields: "id,name" },
          MAX_BUSINESSES_TO_SCAN,
        );
        if (businesses.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No businesses accessible with this token, so no WABAs can be discovered. " +
                  PERMISSION_HINT,
              },
              { type: "text", text: "[]" },
            ],
          };
        }
        businessIds = businesses;
      }

      const wabas: WabaWithSource[] = [];
      for (const biz of businessIds) {
        const owned = await metaApiClient.getPaginated<WhatsAppBusinessAccount>(
          `/${biz.id}/owned_whatsapp_business_accounts`,
          { fields: fieldsParam },
          limit,
        );
        wabas.push(...owned.map((w) => ({ ...w, _source: `owned by ${biz.name ?? biz.id}` })));

        if (include_client_wabas) {
          const client = await metaApiClient.getPaginated<WhatsAppBusinessAccount>(
            `/${biz.id}/client_whatsapp_business_accounts`,
            { fields: fieldsParam },
            limit,
          );
          wabas.push(...client.map((w) => ({ ...w, _source: `shared with ${biz.name ?? biz.id}` })));
        }
        if (wabas.length >= limit) break;
      }

      const unique = [...new Map(wabas.map((w) => [w.id, w])).values()].slice(0, limit);

      if (unique.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No WhatsApp Business Accounts found across ${businessIds.length} business(es). ` +
                PERMISSION_HINT,
            },
            { type: "text", text: "[]" },
          ],
        };
      }

      const lines = [
        `Found ${unique.length} WhatsApp Business Account(s):`,
        ``,
        ...unique.map(
          (w) =>
            `- ${w.name ?? "Unnamed"} (ID: ${w.id})` +
            `${w.account_review_status ? ` — review: ${w.account_review_status}` : ""}` +
            `${w._source ? ` [${w._source}]` : ""}`,
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(unique, null, 2) },
        ],
      };
    },
  );

  // ─── Get Phone Numbers ────────────────────────────────────────
  server.registerTool(
    "whatsapp_get_phone_numbers",
    {
      description:
        "List phone numbers registered on a WhatsApp Business Account, or get details for a single phone number. " +
        "Shows verification status, quality rating, and messaging throughput.",
      inputSchema: {
        waba_id: z
          .string()
          .optional()
          .describe("WhatsApp Business Account ID to list phone numbers for."),
        phone_number_id: z
          .string()
          .optional()
          .describe("Phone number ID for single-number details."),
        fields: z.array(z.string()).optional().describe("Fields to return per phone number."),
        limit: z.number().min(1).max(100).default(25).describe("Maximum phone numbers to return."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id, phone_number_id, fields, limit }) => {
      requireOneOf({ waba_id, phone_number_id }, ["waba_id", "phone_number_id"]);
      const fieldsParam = buildFieldsParam(fields, [...WA_PHONE_DEFAULT_FIELDS]);

      if (phone_number_id) {
        const phone = await metaApiClient.get<WhatsAppPhoneNumber>(
          `/${validateMetaId(phone_number_id, "phone_number_id")}`,
          { fields: `${fieldsParam},messaging_limit_tier` },
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Phone: ${phone.display_phone_number ?? phone.id} (${phone.verified_name ?? "N/A"})\n` +
                `  ID: ${phone.id}\n` +
                `  Verification: ${phone.code_verification_status ?? "N/A"}\n` +
                `  Quality: ${phone.quality_rating ?? "N/A"}\n` +
                `  Status: ${phone.status ?? "N/A"}`,
            },
            { type: "text", text: JSON.stringify(phone, null, 2) },
          ],
        };
      }

      const phones = await metaApiClient.getPaginated<WhatsAppPhoneNumber>(
        `/${validateMetaId(waba_id!, "waba_id")}/phone_numbers`,
        { fields: fieldsParam },
        limit,
      );

      if (phones.length === 0) {
        return {
          content: [
            { type: "text", text: `No phone numbers found on WABA ${waba_id}.` },
            { type: "text", text: "[]" },
          ],
        };
      }

      const lines = [
        `Found ${phones.length} phone number(s) on WABA ${waba_id}:`,
        ``,
        ...phones.map(
          (p) =>
            `- ${p.display_phone_number ?? p.id} "${p.verified_name ?? "N/A"}" (ID: ${p.id})` +
            ` — verification: ${p.code_verification_status ?? "N/A"}, quality: ${p.quality_rating ?? "N/A"}`,
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(phones, null, 2) },
        ],
      };
    },
  );

  // ─── Register Phone ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_register_phone",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Register a phone number for use with the WhatsApp Cloud API. ` +
        "Requires the number's 6-digit two-step verification PIN. If the PIN is rejected, the number " +
        "already has two-step verification enabled with a different PIN — do not retry with guesses.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID to register."),
        pin: z
          .string()
          .regex(/^\d{6}$/, "PIN must be exactly 6 digits")
          .describe("6-digit two-step verification PIN."),
        data_localization_region: z
          .string()
          .length(2)
          .optional()
          .describe("Optional 2-letter country code for local storage of messages (e.g. 'BR', 'IN')."),
      },
      annotations: { ...UPDATE },
    },
    async ({ phone_number_id, pin, data_localization_region }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const body: Record<string, unknown> = { messaging_product: "whatsapp", pin };
      if (data_localization_region) body.data_localization_region = data_localization_region;

      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/register`, body);
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the registration for phone ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Phone number ${phone_number_id} registered for Cloud API use.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Deregister Phone ─────────────────────────────────────────
  server.registerTool(
    "whatsapp_deregister_phone",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Deregister a phone number from the WhatsApp Cloud API. ` +
        "Reversible: the number stays on the WABA and can be re-registered with whatsapp_register_phone.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID to deregister."),
      },
      annotations: { ...TOGGLE },
    },
    async ({ phone_number_id }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/deregister`, {});
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the deregistration for phone ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Phone number ${phone_number_id} deregistered from Cloud API.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Request Verification Code ────────────────────────────────
  server.registerTool(
    "whatsapp_request_verification_code",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Request an ownership verification code for a not-yet-verified phone number, ` +
        "delivered via SMS or voice call. Each call sends a new code. Only applies to numbers whose " +
        "code_verification_status is not VERIFIED.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID to verify."),
        code_method: z.enum(["SMS", "VOICE"]).describe("How to deliver the code."),
        language: z
          .string()
          .default("en_US")
          .describe("Locale for the code message (e.g. en_US, es_ES)."),
      },
      annotations: { ...CREATE },
    },
    async ({ phone_number_id, code_method, language }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/request_code`, {
        code_method,
        language,
      });
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the code request for phone ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Verification code requested for ${phone_number_id} via ${code_method}.\n` +
              `Complete verification with whatsapp_verify_code once received.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Verify Code ──────────────────────────────────────────────
  server.registerTool(
    "whatsapp_verify_code",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Submit the verification code received via whatsapp_request_verification_code ` +
        "to complete phone number ownership verification.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID being verified."),
        code: z
          .string()
          .regex(/^\d{4,8}$/, "Code must be 4-8 digits")
          .describe("Verification code received via SMS or voice."),
      },
      annotations: { ...UPDATE },
    },
    async ({ phone_number_id, code }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const result = await metaApiClient.post<{ success?: boolean }>(`/${id}/verify_code`, { code });
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the verification for phone ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Phone number ${phone_number_id} verified.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Get Business Profile ─────────────────────────────────────
  server.registerTool(
    "whatsapp_get_business_profile",
    {
      description:
        "Get the WhatsApp business profile shown to customers for a phone number: about text, address, " +
        "description, email, websites, vertical, and profile picture URL.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
      },
      annotations: { ...READ },
    },
    async ({ phone_number_id }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const response = await metaApiClient.get<{ data: WhatsAppBusinessProfile[] }>(
        `/${id}/whatsapp_business_profile`,
        { fields: WA_PROFILE_FIELDS.join(",") },
      );
      const profile = response.data?.[0] ?? {};

      const lines = [
        `Business profile for phone ${phone_number_id}:`,
        `  About: ${profile.about ?? "N/A"}`,
        `  Description: ${profile.description ?? "N/A"}`,
        `  Address: ${profile.address ?? "N/A"}`,
        `  Email: ${profile.email ?? "N/A"}`,
        `  Websites: ${profile.websites?.join(", ") ?? "N/A"}`,
        `  Vertical: ${profile.vertical ?? "N/A"}`,
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(profile, null, 2) },
        ],
      };
    },
  );

  // ─── Update Business Profile ──────────────────────────────────
  server.registerTool(
    "whatsapp_update_business_profile",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Update the WhatsApp business profile for a phone number. ` +
        "Only provided fields are changed. Profile picture updates are not supported here " +
        "(they require a resumable media upload).",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
        about: z.string().max(139).optional().describe("Profile about text (max 139 chars)."),
        address: z.string().max(256).optional().describe("Business address."),
        description: z.string().max(512).optional().describe("Business description (max 512 chars)."),
        email: z.string().email().optional().describe("Contact email."),
        websites: z
          .array(z.string().url())
          .max(2)
          .optional()
          .describe("Up to 2 website URLs."),
        vertical: BUSINESS_VERTICAL.optional().describe("Business industry vertical."),
      },
      annotations: { ...UPDATE },
    },
    async ({ phone_number_id, about, address, description, email, websites, vertical }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");

      const body: Record<string, unknown> = { messaging_product: "whatsapp" };
      if (about !== undefined) body.about = about;
      if (address !== undefined) body.address = address;
      if (description !== undefined) body.description = description;
      if (email !== undefined) body.email = email;
      if (websites !== undefined) body.websites = websites;
      if (vertical !== undefined) body.vertical = vertical;

      if (Object.keys(body).length === 1) {
        throw new Error("Provide at least one profile field to update.");
      }

      const result = await metaApiClient.post<{ success?: boolean }>(
        `/${id}/whatsapp_business_profile`,
        body,
      );
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the profile update for phone ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      const updated = Object.keys(body).filter((k) => k !== "messaging_product");
      return {
        content: [
          {
            type: "text",
            text: `Business profile updated for ${phone_number_id} (fields: ${updated.join(", ")}).\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );
}
