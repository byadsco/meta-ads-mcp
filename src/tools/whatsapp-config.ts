import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { validateMetaId } from "../utils/format.js";
import type { WhatsAppQrCode, WebhookSubscription } from "../meta/types/whatsapp.js";
import { READ, CREATE, UPDATE, DELETE, TOGGLE, WHATSAPP_WRITE_WARNING } from "./_register.js";

function validateQrCodeId(code: string): string {
  if (!/^[A-Za-z0-9]{1,64}$/.test(code)) {
    throw new Error(
      `Invalid QR code id: must be alphanumeric. Got: ${JSON.stringify(code).slice(0, 80)}`,
    );
  }
  return code;
}

function describeQr(qr: WhatsAppQrCode): string {
  return (
    `- Code: ${qr.code}\n` +
    `  Message: ${qr.prefilled_message ?? "N/A"}\n` +
    `  Link: ${qr.deep_link_url ?? "N/A"}` +
    (qr.qr_image_url ? `\n  QR image: ${qr.qr_image_url}` : "")
  );
}

export function registerWhatsAppConfigTools(server: McpServer): void {
  // ─── Get QR Codes ─────────────────────────────────────────────
  server.registerTool(
    "whatsapp_get_qr_codes",
    {
      description:
        "List QR code deep links for a WhatsApp phone number, or get one by its code. Each QR code " +
        "opens a chat with a prefilled message when scanned.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
        code: z.string().optional().describe("Specific QR code id to fetch."),
      },
      annotations: { ...READ },
    },
    async ({ phone_number_id, code }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");

      const path = code
        ? `/${id}/message_qrdls/${validateQrCodeId(code)}`
        : `/${id}/message_qrdls`;
      // Meta documents the single-code GET as {data:[...]} like the list edge,
      // but tolerate a bare-object response so a shape change can't produce a
      // false "no QR codes found".
      const response = await metaApiClient.get<{ data?: WhatsAppQrCode[]; code?: string }>(path);
      const codes: WhatsAppQrCode[] =
        response.data ?? (response.code ? [response as WhatsAppQrCode] : []);

      if (codes.length === 0) {
        return {
          content: [
            { type: "text", text: `No QR codes found for phone ${phone_number_id}.` },
            { type: "text", text: "[]" },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${codes.length} QR code(s) for phone ${phone_number_id}:\n\n${codes.map(describeQr).join("\n")}`,
          },
          { type: "text", text: JSON.stringify(codes, null, 2) },
        ],
      };
    },
  );

  // ─── Create QR Code ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_create_qr_code",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Create a QR code deep link for a WhatsApp phone number. Scanning it ` +
        "opens a chat with the prefilled message. Returns the code, wa.me deep link, and optionally " +
        "a QR image URL.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
        prefilled_message: z
          .string()
          .min(1)
          .max(140)
          .describe("Message prefilled in the user's chat when they scan the code."),
        generate_qr_image: z
          .enum(["SVG", "PNG"])
          .optional()
          .describe("Also return a rendered QR image in this format."),
      },
      annotations: { ...CREATE },
    },
    async ({ phone_number_id, prefilled_message, generate_qr_image }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");

      const body: Record<string, unknown> = { prefilled_message };
      if (generate_qr_image) body.generate_qr_image = generate_qr_image;

      const qr = await metaApiClient.post<WhatsAppQrCode>(`/${id}/message_qrdls`, body);

      return {
        content: [
          { type: "text", text: `QR code created for phone ${phone_number_id}:\n${describeQr(qr)}` },
          { type: "text", text: JSON.stringify(qr, null, 2) },
        ],
      };
    },
  );

  // ─── Update QR Code ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_update_qr_code",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Update the prefilled message of an existing QR code deep link. ` +
        "The code and deep link URL stay the same.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
        code: z.string().describe("QR code id to update."),
        prefilled_message: z.string().min(1).max(140).describe("New prefilled message."),
      },
      annotations: { ...UPDATE },
    },
    async ({ phone_number_id, code, prefilled_message }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");

      const qr = await metaApiClient.post<WhatsAppQrCode>(`/${id}/message_qrdls`, {
        code: validateQrCodeId(code),
        prefilled_message,
      });

      return {
        content: [
          { type: "text", text: `QR code ${code} updated:\n${describeQr(qr)}` },
          { type: "text", text: JSON.stringify(qr, null, 2) },
        ],
      };
    },
  );

  // ─── Delete QR Code ───────────────────────────────────────────
  server.registerTool(
    "whatsapp_delete_qr_code",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Delete a QR code deep link. Scans of the printed code stop working. ` +
        "Cannot be undone.",
      inputSchema: {
        phone_number_id: z.string().describe("Phone number ID."),
        code: z.string().describe("QR code id to delete."),
      },
      annotations: { ...DELETE },
    },
    async ({ phone_number_id, code }) => {
      const id = validateMetaId(phone_number_id, "phone_number_id");
      const result = await metaApiClient.delete<{ success?: boolean }>(
        `/${id}/message_qrdls/${validateQrCodeId(code)}`,
      );
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the deletion of QR code ${code}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `QR code ${code} deleted from phone ${phone_number_id}.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Get Webhook Subscriptions ────────────────────────────────
  server.registerTool(
    "whatsapp_get_webhook_subscriptions",
    {
      description:
        "List the apps subscribed to webhook events on a WhatsApp Business Account, including any " +
        "callback URI override.",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
      },
      annotations: { ...READ },
    },
    async ({ waba_id }) => {
      const id = validateMetaId(waba_id, "waba_id");
      const response = await metaApiClient.get<{ data: WebhookSubscription[] }>(
        `/${id}/subscribed_apps`,
      );
      const subs = response.data ?? [];

      if (subs.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No apps subscribed to webhooks on WABA ${waba_id}. ` +
                `Use whatsapp_subscribe_webhook to subscribe this server's Meta app.`,
            },
            { type: "text", text: "[]" },
          ],
        };
      }

      const lines = [
        `${subs.length} app(s) subscribed to WABA ${waba_id} webhooks:`,
        ``,
        ...subs.map(
          (s) =>
            `- ${s.whatsapp_business_api_data?.name ?? "Unknown app"} (ID: ${s.whatsapp_business_api_data?.id ?? "?"})` +
            (s.override_callback_uri ? `\n  Callback override: ${s.override_callback_uri}` : ""),
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(subs, null, 2) },
        ],
      };
    },
  );

  // ─── Subscribe Webhook ────────────────────────────────────────
  server.registerTool(
    "whatsapp_subscribe_webhook",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Subscribe the Meta app that owns this access token to webhook events ` +
        "on a WABA (messages, template status updates, etc.). Events are delivered to the app's " +
        "configured webhook endpoint — this server does not receive them. Optionally override the " +
        "callback URL for this WABA (override_callback_uri and verify_token must be provided together).",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
        override_callback_uri: z
          .string()
          .url()
          .optional()
          .describe("Alternate callback URL for this WABA only (requires verify_token)."),
        verify_token: z
          .string()
          .optional()
          .describe("Verify token Meta will send to the override callback (required with override_callback_uri)."),
      },
      annotations: { ...TOGGLE },
    },
    async ({ waba_id, override_callback_uri, verify_token }) => {
      const id = validateMetaId(waba_id, "waba_id");

      if (Boolean(override_callback_uri) !== Boolean(verify_token)) {
        throw new Error("override_callback_uri and verify_token must be provided together.");
      }

      const body: Record<string, unknown> = {};
      if (override_callback_uri) {
        body.override_callback_uri = override_callback_uri;
        body.verify_token = verify_token;
      }

      const result = await metaApiClient.post<{ success?: boolean }>(
        `/${id}/subscribed_apps`,
        body,
      );
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the webhook subscription for WABA ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              `App subscribed to webhooks on WABA ${waba_id}` +
              `${override_callback_uri ? ` with callback override ${override_callback_uri}` : ""}.\n` +
              `${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );

  // ─── Unsubscribe Webhook ──────────────────────────────────────
  server.registerTool(
    "whatsapp_unsubscribe_webhook",
    {
      description:
        `${WHATSAPP_WRITE_WARNING}Unsubscribe the Meta app that owns this access token from webhook ` +
        "events on a WABA. The app stops receiving message and template events for this account.",
      inputSchema: {
        waba_id: z.string().describe("WhatsApp Business Account ID."),
      },
      annotations: { ...TOGGLE },
    },
    async ({ waba_id }) => {
      const id = validateMetaId(waba_id, "waba_id");
      const result = await metaApiClient.delete<{ success?: boolean }>(`/${id}/subscribed_apps`);
      if (result?.success !== true) {
        throw new Error(
          `Meta did not confirm the webhook unsubscription for WABA ${id}. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `App unsubscribed from webhooks on WABA ${waba_id}.\n${JSON.stringify(result)}`,
          },
        ],
      };
    },
  );
}
