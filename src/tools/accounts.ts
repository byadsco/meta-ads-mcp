import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId, validateNumericId } from "../utils/format.js";
import { readList } from "../meta/read-list.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
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
import { readSpendCap, SPEND_CAP_NOT_REPORTED } from "../meta/spend-cap.js";
import { READ } from "./_register.js";

export function registerAccountTools(server: McpServer): void {
  // ─── Get Ad Accounts ─────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_accounts",
    {
      description:
        "Get all ad accounts accessible by the authenticated user. Returns account names, IDs, status, currency, and spend information.",
      inputSchema: {
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
      annotations: { ...READ },
    },
    async ({ user_id, limit, fields }) => {
      const userPath = user_id === "me" ? "me" : validateMetaId(user_id, "user");
      const fieldsParam = buildFieldsParam(
        fields,
        [...AD_ACCOUNT_DEFAULT_FIELDS],
      );

      const response = await metaApiClient.get<MetaApiResponse<AdAccount>>(
        `/${userPath}/adaccounts`,
        { fields: fieldsParam, limit },
      );

      const accounts = response.data ?? [];

      const text = accounts.length === 0
        ? "No ad accounts found for this user."
        : accounts
            .map((a) => {
              // A caller's own `fields` may leave any of these out: a field
              // that was not requested is not printed, least of all as a
              // status of DISABLED.
              const reference = a.account_id ?? a.id;
              return [
                `• ${a.name ? `${a.name} (${reference})` : reference}`,
                ...(a.account_status !== undefined ? [`Status: ${a.account_status === 1 ? "ACTIVE" : "DISABLED"}`] : []),
                ...(a.currency !== undefined ? [`Currency: ${a.currency}`] : []),
                `Spent: ${a.amount_spent ?? "N/A"}`,
              ].join(" — ");
            })
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
  server.registerTool(
    "ads_get_account_info",
    {
      description:
        "Get detailed information about a specific ad account including spend, balance, capabilities, and business details.",
      inputSchema: {
        account_id: z
          .string()
          .describe("Ad account ID (with or without 'act_' prefix)"),
      },
      annotations: { ...READ },
    },
    async ({ account_id }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = [...AD_ACCOUNT_DETAIL_FIELDS].join(",");

      const account = await metaApiClient.get<AdAccount>(`/${id}`, {
        fields: fieldsParam,
      });

      // A cap that is set is printed as Meta sent it, like the other amounts
      // here; "None" is for the zero Meta sends when there is no cap.
      const cap = readSpendCap(account.spend_cap);
      const spendCapText = cap.state === "unknown"
        ? SPEND_CAP_NOT_REPORTED
        : cap.state === "none" ? "None" : account.spend_cap;

      return {
        content: [
          {
            type: "text",
            text: `Account: ${account.name} (${account.account_id})\nStatus: ${account.account_status === 1 ? "ACTIVE" : "DISABLED"}\nCurrency: ${account.currency}\nTimezone: ${account.timezone_name}\nSpent: ${account.amount_spent ?? "N/A"}\nBalance: ${account.balance ?? "N/A"}\nSpend Cap: ${spendCapText}`,
          },
          { type: "text", text: JSON.stringify(account, null, 2) },
        ],
      };
    },
  );

  // ─── Get Pages For Business ──────────────────────────────────
  server.registerTool(
    "ads_get_pages_for_business",
    {
      description:
        "Get the Facebook Pages a Business Manager owns (business_id), as Meta's official tool of this name does. " +
        "Still takes an ad account (account_id) or nothing for the person's own Pages, as before; " +
        "ads_get_ad_account_pages and ads_get_user_pages are the dedicated tools for those. Pages are required for creating ad creatives.",
      inputSchema: {
        business_id: z
          .string()
          .optional()
          .describe("Business Manager whose owned Pages to list. Use instead of account_id."),
        account_id: z
          .string()
          .optional()
          .describe(
            "Ad account ID to get associated pages. Omit to get user's own pages.",
          ),
      },
      annotations: { ...READ },
    },
    async ({ business_id, account_id }) => {
      const fieldsParam = [...PAGE_DEFAULT_FIELDS].join(",");

      let pages: Page[];

      if (business_id !== undefined) {
        if (account_id !== undefined) throw new Error("Pass business_id or account_id, not both.");
        const business = validateNumericId(business_id, "business_id");
        const { items, complete } = await readList<ListedPage>(`/${business}/owned_pages`, { fields: "id,name,category", limit: 100 }, BUSINESS_PAGES_MAX);
        const lines = [
          items.length === 0
            ? `Business Manager ${business} owns no Pages Meta shows this token.`
            : `${count(items.length, "Page")} owned by Business Manager ${business}.`,
          ...(complete ? [] : ["Meta lists more Pages than these; they could not all be read."]),
          ...(items.length ? fence(items.map((p) => pageLine(p))) : []),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } else if (account_id) {
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

  // ─── Pages used for ads on an account (official name) ────────
  server.registerTool(
    "ads_get_ad_account_pages",
    {
      description:
        "List the Facebook Pages that have been used for ads on an ad account, with their page_id for creatives. " +
        "Page names are written by their owners and come inside an untrusted-content fence.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (with or without 'act_' prefix)"),
        limit: z.number().int().min(1).max(PAGES_MAX_LIMIT).default(100).describe("Most Pages to list"),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit }) => {
      const id = normalizeAccountId(account_id);
      const { items, complete } = await readList<ListedPage>(
        `/${id}/promote_pages`,
        { fields: "id,name,category,is_published", limit: Math.min(limit, 100) },
        limit,
      );
      const pages = items.slice(0, limit);
      const more = !complete || items.length > limit;
      const lines = [
        pages.length === 0 ? `No Pages have been used for ads on ${id}.` : `${count(pages.length, "Page")} used for ads on ${id}.`,
        ...(more ? [morePages(limit)] : []),
        ...(pages.length ? fence(pages.map((p) => pageLine(p))) : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Pages the person can advertise with (official name) ─────
  server.registerTool(
    "ads_get_user_pages",
    {
      description:
        "List every Facebook Page the authenticated person can use for advertising, across their businesses: " +
        "the Pages where they hold the ADVERTISE task, with the linked Instagram account when there is one. " +
        "Page names are written by their owners and come inside an untrusted-content fence.",
      inputSchema: {
        limit: z.number().int().min(1).max(PAGES_MAX_LIMIT).default(100).describe("Most Pages to read from Meta"),
      },
      annotations: { ...READ },
    },
    async ({ limit }) => {
      // The fields are fixed here: /me/accounts answers with each Page's
      // access token unless the fields leave it out.
      const { items, complete } = await readList<ListedPage>(
        "/me/accounts",
        { fields: "id,name,category,tasks,instagram_business_account{id,username}", limit: Math.min(limit, 100) },
        limit,
      );
      const read = items.slice(0, limit);
      const usable = read.filter((p) => Array.isArray(p.tasks) && p.tasks.includes("ADVERTISE"));
      const others = read.length - usable.length;
      const lines = [
        usable.length === 0 ? "No Pages this person can advertise with." : `${count(usable.length, "Page")} this person can advertise with.`,
        ...(others > 0 ? [`${count(others, "more Page")} where they have a role but cannot advertise (no ADVERTISE task) left out.`] : []),
        ...(!complete || items.length > limit ? [morePages(limit)] : []),
        ...(usable.length ? fence(usable.map((p) => pageLine(p))) : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

interface ListedPage {
  id?: string;
  name?: string;
  category?: string;
  is_published?: boolean;
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string };
}

const BUSINESS_PAGES_MAX = 500;
const PAGES_MAX_LIMIT = 500;
const morePages = (limit: number) =>
  `Meta lists more Pages than these; ${limit < PAGES_MAX_LIMIT ? "raise limit to see them." : `this tool reads at most ${PAGES_MAX_LIMIT}.`}`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const fence = (lines: string[]) => [ADVERTISER_CONTENT_OPEN, ...lines, ADVERTISER_CONTENT_CLOSE];

function pageLine(page: ListedPage): string {
  const ig = page.instagram_business_account;
  return [
    `• ${singleLine(page.name, 100) || "(unnamed)"} — page_id ${singleLine(page.id, 30)}`,
    ...(page.category ? [singleLine(page.category, 60)] : []),
    ...(page.is_published === false ? ["unpublished"] : []),
    ...(ig?.id ? [`Instagram @${singleLine(ig.username, 60) || "?"} (${singleLine(ig.id, 30)})`] : []),
  ].join(" — ");
}
