import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import {
  AD_ACCOUNT_DEFAULT_FIELDS,
  AD_ACCOUNT_DETAIL_FIELDS,
  PAGE_DEFAULT_FIELDS,
} from "../meta/types/account.js";
import type {
  AdAccount,
  Page,
  MetaApiResponse,
} from "../meta/types/index.js";

export function registerAccountTools(server: McpServer): void {
  // ─── Get Ad Accounts ─────────────────────────────────────────
  server.tool(
    "meta_ads_get_ad_accounts",
    "Get all ad accounts accessible by the authenticated user. Returns account names, IDs, status, currency, and spend information.",
    {
      user_id: z
        .string()
        .default("me")
        .describe("User ID or 'me' for the authenticated user"),
      limit: z
        .number()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum number of accounts to return"),
      fields: z
        .array(z.string())
        .optional()
        .describe("Fields to include (defaults to standard set)"),
    },
    async ({ user_id, limit, fields }) => {
      const fieldsParam = buildFieldsParam(
        fields,
        [...AD_ACCOUNT_DEFAULT_FIELDS],
      );

      const response = await metaApiClient.get<MetaApiResponse<AdAccount>>(
        `/${user_id}/adaccounts`,
        { fields: fieldsParam, limit },
      );

      const accounts = response.data ?? [];

      const text = accounts.length === 0
        ? "No ad accounts found for this user."
        : accounts
            .map(
              (a) =>
                `• ${a.name} (${a.account_id}) — Status: ${a.account_status === 1 ? "ACTIVE" : "DISABLED"} — Currency: ${a.currency} — Spent: ${a.amount_spent ?? "N/A"}`,
            )
            .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${accounts.length} ad account(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(accounts, null, 2) },
        ],
      };
    },
  );

  // ─── Get Account Info ────────────────────────────────────────
  server.tool(
    "meta_ads_get_account_info",
    "Get detailed information about a specific ad account including spend, balance, capabilities, and business details.",
    {
      account_id: z
        .string()
        .describe("Ad account ID (with or without 'act_' prefix)"),
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = [...AD_ACCOUNT_DETAIL_FIELDS].join(",");

      const account = await metaApiClient.get<AdAccount>(`/${id}`, {
        fields: fieldsParam,
      });

      return {
        content: [
          {
            type: "text",
            text: `Account: ${account.name} (${account.account_id})\nStatus: ${account.account_status === 1 ? "ACTIVE" : "DISABLED"}\nCurrency: ${account.currency}\nTimezone: ${account.timezone_name}\nSpent: ${account.amount_spent ?? "N/A"}\nBalance: ${account.balance ?? "N/A"}\nSpend Cap: ${account.spend_cap ?? "None"}`,
          },
          { type: "text", text: JSON.stringify(account, null, 2) },
        ],
      };
    },
  );

  // ─── Get Pages ───────────────────────────────────────────────
  server.tool(
    "meta_ads_get_pages",
    "Get Facebook Pages associated with an ad account or the authenticated user. Pages are required for creating ad creatives.",
    {
      account_id: z
        .string()
        .optional()
        .describe(
          "Ad account ID to get associated pages. Omit to get user's own pages.",
        ),
    },
    async ({ account_id }) => {
      const fieldsParam = [...PAGE_DEFAULT_FIELDS].join(",");

      let pages: Page[];

      if (account_id) {
        const id = normalizeAccountId(account_id);
        // Try promoted_pages first, then owned_pages
        try {
          const response = await metaApiClient.get<MetaApiResponse<Page>>(
            `/${id}/promote_pages`,
            { fields: fieldsParam },
          );
          pages = response.data ?? [];
        } catch {
          const response = await metaApiClient.get<MetaApiResponse<Page>>(
            `/${id}/owned_pages`,
            { fields: fieldsParam },
          );
          pages = response.data ?? [];
        }
      } else {
        const response = await metaApiClient.get<MetaApiResponse<Page>>(
          "/me/accounts",
          { fields: fieldsParam },
        );
        pages = response.data ?? [];
      }

      const text =
        pages.length === 0
          ? "No pages found."
          : pages
              .map(
                (p) => `• ${p.name} (ID: ${p.id}) — Category: ${p.category ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${pages.length} page(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(pages, null, 2) },
        ],
      };
    },
  );
}
