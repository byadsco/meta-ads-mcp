import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getGeminiClient,
  isGeminiEnvFallbackUsable,
  maskGeminiKey,
  resolveGeminiTenantId,
  scrubGeminiKey,
  validateGeminiKeyInput,
  type GeminiClient,
} from "../gemini/client.js";
import { getGeminiKeyRepo, type GeminiKeyRepo } from "../store/gemini-key-repo.js";
import { hashPii } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { singleLine } from "../utils/single-line.js";
import { DELETE, GEMINI_WRITE_WARNING, READ, TOKEN } from "./_register.js";

export interface GeminiKeyToolDeps {
  repo?: GeminiKeyRepo;
  client?: GeminiClient;
  resolveTenantId?: () => string;
}

const REJECTION_HINT: Record<string, string> = {
  empty: "The key is empty.",
  "too-short": "That value is too short to be a Gemini API key.",
  "too-long": "That value is too long to be a Gemini API key.",
  "illegal-chars": "A Gemini API key has no spaces, line breaks or control characters.",
};

export function registerGeminiKeyTools(server: McpServer, deps: GeminiKeyToolDeps = {}): void {
  const repo = () => deps.repo ?? getGeminiKeyRepo();
  const client = () => deps.client ?? getGeminiClient();
  const tenantId = () => (deps.resolveTenantId ?? resolveGeminiTenantId)();

  server.registerTool(
    "ads_register_gemini_key",
    {
      description:
        `${GEMINI_WRITE_WARNING}Register your Google Gemini API key so ads_analyze_video can describe and score ad videos for models that cannot watch video themselves. ` +
        "The key is checked against the Gemini API and then stored encrypted (AES-256-GCM), scoped to your account. Create one at aistudio.google.com/apikey. " +
        "Use a paid-tier key for client creatives: Google may use free-tier inputs to improve its models. Videos are sent to Gemini for analysis, and larger ones are held in Google's Files API for up to 48 hours. " +
        "Most users register the key on the server's /auth/connections page instead of calling this tool.",
      inputSchema: {
        gemini_api_key: z.string().min(20).max(512).describe("Gemini API key from Google AI Studio (current keys start with AQ.)"),
      },
      annotations: { ...TOKEN },
    },
    async ({ gemini_api_key }) => {
      const tenant = tenantId();
      const parsed = validateGeminiKeyInput(gemini_api_key);
      if (!parsed.ok) {
        return {
          content: [{ type: "text", text: `${REJECTION_HINT[parsed.reason]} The key was NOT stored. Copy it again from aistudio.google.com/apikey.` }],
          isError: true,
        };
      }

      try {
        await client().validateKey(parsed.key);
      } catch (error) {
        // Scrubbed again at the boundary: the client already does it, but this
        // string is what reaches the MCP client, so it must not depend on that.
        const raw = error instanceof Error ? error.message : String(error);
        const detail = singleLine(scrubGeminiKey(raw, parsed.key), 300);
        logger.warn({ event: "gemini_key_register_failed", tenant: hashPii(tenant) }, "Gemini key validation failed");
        return {
          content: [{ type: "text", text: `Gemini key validation failed: ${detail}\n\nThe key was NOT stored.` }],
          isError: true,
        };
      }

      await repo().saveKey(tenant, parsed.key);
      logger.info({ event: "gemini_key_registered", tenant: hashPii(tenant) }, "Gemini key registered");

      return {
        content: [
          {
            type: "text",
            text:
              `Gemini key registered and encrypted at rest.\nKey: ${maskGeminiKey(parsed.key)}\n\n` +
              "ads_analyze_video is now available. If your own model can watch video, ads_get_video_media delivery=inline is cheaper and needs no key.",
          },
        ],
      };
    },
  );

  server.registerTool(
    "ads_get_gemini_key_status",
    {
      description:
        "Check whether a Gemini API key is available for the current user and where it comes from (encrypted per-user storage or the GEMINI_API_KEY environment fallback), and optionally verify it still works against the Gemini API.",
      inputSchema: {
        verify: z.boolean().default(false).describe("Also call the Gemini API to confirm the key still works"),
      },
      annotations: { ...READ },
    },
    async ({ verify }) => {
      const tenant = tenantId();
      const status = await repo().getStatus(tenant);
      const envAvailable = isGeminiEnvFallbackUsable();
      const source = status.registered ? "encrypted_user_storage" : envAvailable ? "env" : "none";

      let verification = "not requested";
      if (verify && source !== "none") {
        const key = source === "encrypted_user_storage" ? await repo().getDecryptedKey(tenant) : process.env.GEMINI_API_KEY?.trim();
        if (!key) {
          verification = "invalid — the key could not be read";
        } else {
          try {
            await client().validateKey(key);
            verification = "valid";
          } catch (error) {
            verification = `invalid — ${singleLine(scrubGeminiKey(error instanceof Error ? error.message : String(error), key), 300)}`;
          }
        }
      }

      const summary =
        source === "none"
          ? "No Gemini API key available. Register one on the /auth/connections page or with ads_register_gemini_key (create it at aistudio.google.com/apikey). Without a key, ads_get_video_media delivery=frames still lets an image-capable model look at the video."
          : `Gemini key source: ${source}` +
            (status.updatedAt ? `\nLast updated: ${new Date(status.updatedAt * 1000).toISOString()}` : "") +
            `\nVerification: ${verification}`;

      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify({ source, envFallbackAvailable: envAvailable, ...status, verification }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "ads_delete_gemini_key",
    {
      description: `${GEMINI_WRITE_WARNING}Delete the Gemini API key stored for the current user. Does not affect the GEMINI_API_KEY environment fallback, if one is configured, and does not revoke the key at Google.`,
      inputSchema: {},
      annotations: { ...DELETE },
    },
    async () => {
      const tenant = tenantId();
      const deleted = await repo().deleteKey(tenant);
      const envAvailable = isGeminiEnvFallbackUsable();
      const envNote = envAvailable ? " Note: the GEMINI_API_KEY environment fallback is still active and will be used." : "";

      if (!deleted) {
        return {
          content: [{ type: "text", text: `No stored Gemini key found for this user.${envNote}` }],
          isError: true,
        };
      }

      logger.info({ event: "gemini_key_deleted", tenant: hashPii(tenant) }, "Gemini key deleted");
      return {
        content: [{ type: "text", text: `Stored Gemini key deleted.${envNote} Revoke it at aistudio.google.com/apikey if you no longer want it to exist.` }],
      };
    },
  );
}
