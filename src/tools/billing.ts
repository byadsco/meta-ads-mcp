import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, formatBudget } from "../utils/format.js";

interface BillingInfo {
  id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  spend_cap?: string;
  amount_spent?: string;
  balance?: string;
  funding_source_details?: {
    id: string;
    display_string?: string;
    type?: number;
  };
  owner?: string;
  business_name?: string;
  account_status?: number;
  disable_reason?: number;
}

const BILLING_FIELDS = [
  "id",
  "name",
  "currency",
  "timezone_name",
  "spend_cap",
  "amount_spent",
  "balance",
  "funding_source_details",
  "owner",
  "business_name",
  "account_status",
  "disable_reason",
].join(",");

const SPEND_FIELDS = [
  "id",
  "name",
  "currency",
  "spend_cap",
  "amount_spent",
  "balance",
  "daily_spend_limit",
  "min_daily_budget",
].join(",");

interface SpendInfo {
  id: string;
  name?: string;
  currency?: string;
  spend_cap?: string;
  amount_spent?: string;
  balance?: string;
  daily_spend_limit?: string;
  min_daily_budget?: number;
}

const ACCOUNT_STATUS_MAP: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

export function registerBillingTools(server: McpServer): void {
  // ─── Get Billing Info ─────────────────────────────────────────
  server.tool(
    "meta_ads_get_billing_info",
    "Get billing and payment information for an ad account, including funding source, account status, and spend data.",
    {
      account_id: z.string().describe("Ad account ID"),
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);

      const info = await metaApiClient.get<BillingInfo>(
        `/${id}`,
        { fields: BILLING_FIELDS },
      );

      const currency = info.currency ?? "USD";
      const statusText = info.account_status !== undefined
        ? ACCOUNT_STATUS_MAP[info.account_status] ?? `UNKNOWN (${info.account_status})`
        : "N/A";

      const lines: string[] = [
        `Account: ${info.name ?? info.id}`,
        `Business: ${info.business_name ?? "N/A"}`,
        `Status: ${statusText}`,
        `Currency: ${currency}`,
        `Timezone: ${info.timezone_name ?? "N/A"}`,
        ``,
        `Spending:`,
        `  Amount Spent: ${info.amount_spent ? formatBudget(info.amount_spent, currency) : "N/A"}`,
        `  Spend Cap: ${info.spend_cap ? formatBudget(info.spend_cap, currency) : "No limit"}`,
        `  Balance: ${info.balance ? formatBudget(info.balance, currency) : "N/A"}`,
      ];

      if (info.funding_source_details) {
        lines.push(
          ``,
          `Payment Method:`,
          `  ${info.funding_source_details.display_string ?? "N/A"} (ID: ${info.funding_source_details.id})`,
        );
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(info, null, 2) },
        ],
      };
    },
  );

  // ─── Get Spend Limit ──────────────────────────────────────────
  server.tool(
    "meta_ads_get_spend_limit",
    "Get spending limits and current spend for an ad account. Shows spend cap, amount spent, daily limits, and remaining balance.",
    {
      account_id: z.string().describe("Ad account ID"),
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);

      const info = await metaApiClient.get<SpendInfo>(
        `/${id}`,
        { fields: SPEND_FIELDS },
      );

      const currency = info.currency ?? "USD";

      const spendCap = info.spend_cap ? parseInt(info.spend_cap, 10) : null;
      const amountSpent = info.amount_spent ? parseInt(info.amount_spent, 10) : null;
      const remaining =
        spendCap !== null && amountSpent !== null ? spendCap - amountSpent : null;

      const lines: string[] = [
        `Account: ${info.name ?? info.id}`,
        ``,
        `Spend Cap: ${spendCap !== null ? formatBudget(spendCap, currency) : "No limit set"}`,
        `Amount Spent: ${amountSpent !== null ? formatBudget(amountSpent, currency) : "N/A"}`,
      ];

      if (remaining !== null) {
        lines.push(`Remaining: ${formatBudget(remaining, currency)}`);
        if (spendCap !== null && spendCap > 0) {
          const pctUsed = ((amountSpent! / spendCap) * 100).toFixed(1);
          lines.push(`Usage: ${pctUsed}% of spend cap used`);
        }
      }

      if (info.balance) lines.push(`Balance: ${formatBudget(info.balance, currency)}`);
      if (info.daily_spend_limit) lines.push(`Daily Spend Limit: ${formatBudget(info.daily_spend_limit, currency)}`);
      if (info.min_daily_budget !== undefined) lines.push(`Min Daily Budget: ${formatBudget(info.min_daily_budget, currency)}`);

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(info, null, 2) },
        ],
      };
    },
  );

  // ─── Update Spend Cap ─────────────────────────────────────────
  server.tool(
    "meta_ads_update_spend_cap",
    "Update the spending limit (spend cap) for an ad account. Set to 0 or omit to remove the cap.",
    {
      account_id: z.string().describe("Ad account ID"),
      spend_cap: z
        .number()
        .min(0)
        .describe("New spend cap in cents (e.g., 100000 = $1,000.00). Use 0 to remove."),
    },
    async ({ account_id, spend_cap }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {};
      if (spend_cap > 0) {
        body.spend_cap = spend_cap;
      } else {
        body.spend_cap = 0;
      }

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      const displayAmount = spend_cap > 0 ? formatBudget(spend_cap) : "No limit (removed)";

      return {
        content: [
          {
            type: "text",
            text: `Spend cap updated for account ${account_id}.\nNew spend cap: ${displayAmount}`,
          },
        ],
      };
    },
  );
}
