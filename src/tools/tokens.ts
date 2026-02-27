import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenManager, maskToken } from "../auth/token-manager.js";
import { logger } from "../utils/logger.js";

const META_API_VERSION = process.env.META_API_VERSION ?? "v22.0";
const META_BASE_URL = "https://graph.facebook.com";

/**
 * Validate a token by calling GET /me against the Meta Graph API.
 * Uses raw fetch (not MetaApiClient) because we need to test the
 * candidate token, not the currently active one.
 */
async function validateTokenWithMeta(
  token: string,
): Promise<{ valid: boolean; name?: string; error?: string }> {
  try {
    const url = `${META_BASE_URL}/${META_API_VERSION}/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    const body = (await response.json()) as Record<string, unknown>;

    if (body.error) {
      const err = body.error as { message?: string };
      return { valid: false, error: err.message ?? "Unknown Meta API error" };
    }

    if (!response.ok) {
      return { valid: false, error: `HTTP ${response.status}` };
    }

    return { valid: true, name: String(body.name ?? "") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Validation request failed: ${message}` };
  }
}

export function registerTokenTools(server: McpServer): void {
  // ─── List Tokens ──────────────────────────────────────────
  server.tool(
    "meta_ads_list_tokens",
    "List all registered Business Managers / token names with their active status. Never exposes actual token values.",
    {},
    async () => {
      const { active, available } = tokenManager.listTokens();

      if (available.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No tokens registered. Set META_TOKENS or META_ACCESS_TOKEN environment variable, or use meta_ads_register_token to add one.",
            },
          ],
        };
      }

      const lines = available.map(
        (name) => `• ${name}${name === active ? " [ACTIVE]" : ""}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Registered tokens (${available.length}):\n\n${lines.join("\n")}`,
          },
          {
            type: "text",
            text: JSON.stringify({ active, available }, null, 2),
          },
        ],
      };
    },
  );

  // ─── Set Active Token ─────────────────────────────────────
  server.tool(
    "meta_ads_set_active_token",
    "Switch the active Meta API token by Business Manager name. All subsequent API calls will use this token.",
    {
      bm_name: z
        .string()
        .min(1)
        .describe("Name of the registered token / Business Manager to activate"),
    },
    async ({ bm_name }) => {
      const success = tokenManager.setActiveToken(bm_name);

      if (!success) {
        const { available } = tokenManager.listTokens();
        return {
          content: [
            {
              type: "text",
              text: `Token "${bm_name}" not found. Available tokens: ${available.join(", ") || "none"}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Active token switched to "${bm_name}". All subsequent API calls will use this token.`,
          },
        ],
      };
    },
  );

  // ─── Register Token ───────────────────────────────────────
  server.tool(
    "meta_ads_register_token",
    "Register a new Meta API access token with a friendly name. Validates the token against the Meta Graph API (GET /me) before registering. The token is stored in memory only (not persisted across restarts).",
    {
      bm_name: z
        .string()
        .min(1)
        .max(64)
        .describe("Friendly name for this token (e.g. 'byads', 'client_acme')"),
      access_token: z
        .string()
        .min(10)
        .describe("Meta API access token to register"),
    },
    async ({ bm_name, access_token }) => {
      // Validate the token via GET /me
      logger.info(
        { tokenName: bm_name, maskedToken: maskToken(access_token) },
        "Validating token before registration",
      );
      const validation = await validateTokenWithMeta(access_token);

      if (!validation.valid) {
        logger.warn(
          { tokenName: bm_name, error: validation.error },
          "Token validation failed",
        );
        return {
          content: [
            {
              type: "text",
              text: `Token validation failed: ${validation.error}\n\nThe token was NOT registered. Please provide a valid Meta API access token.`,
            },
          ],
          isError: true,
        };
      }

      tokenManager.registerToken(bm_name, access_token);

      return {
        content: [
          {
            type: "text",
            text:
              `Token "${bm_name}" registered successfully.\n` +
              `Validated as: ${validation.name}\n` +
              `Token: ${maskToken(access_token)}`,
          },
        ],
      };
    },
  );
}
