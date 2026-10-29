import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId, validateNumericId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { wasRefused } from "../meta/errors.js";
import { readList, scrubbed } from "../meta/read-list.js";
import { buildCustomerPayload } from "../meta/customer-data.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { AUDIENCE_DEFAULT_FIELDS } from "../meta/types/audience.js";
import type { CustomAudience, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";

export function registerAudienceTools(server: McpServer): void {
  // ─── Get Custom Audiences ─────────────────────────────────────
  server.registerTool(
    "ads_get_custom_audiences",
    {
      description:
        "List custom audiences for an ad account. Includes lookalikes, website audiences, customer lists, engagement audiences and offline-conversion audiences. Use the returned audience id with ads_update_ad_set (targeting.custom_audiences=[{id}]) to apply the audience to an ad set.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<CustomAudience>>(
        `/${id}/customaudiences`,
        { fields: fieldsParam, limit },
      );
      const audiences = response.data ?? [];

      const text =
        audiences.length === 0
          ? "No custom audiences found."
          : audiences
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — Type: ${a.subtype} — Size: ${a.approximate_count_lower_bound ?? "?"}-${a.approximate_count_upper_bound ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${audiences.length} audience(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(audiences, null, 2) },
        ],
      };
    },
  );

  // ─── Get Audience Details ─────────────────────────────────────
  server.registerTool(
    "ads_get_audience_details",
    {
      description:
        "Get detailed information about a specific custom audience, including subtype, retention period, approximate size bounds and lookalike spec. Useful before applying it to an ad set via ads_update_ad_set.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, fields }) => {
      const id = validateMetaId(audience_id, "audience");
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const audience = await metaApiClient.get<CustomAudience>(
        `/${id}`,
        { fields: fieldsParam },
      );

      return {
        content: [
          {
            type: "text",
            text: `Audience: ${audience.name} (${audience.id})\nType: ${audience.subtype}\nSize: ${audience.approximate_count_lower_bound ?? "?"}-${audience.approximate_count_upper_bound ?? "?"}`,
          },
          { type: "text", text: JSON.stringify(audience, null, 2) },
        ],
      };
    },
  );

  // ─── Create Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_create_custom_audience",
    {
      description: `${WRITE_WARNING}Create a custom audience on an ad account. Two main flows: (a) WEBSITE pixel-based — pass 'rule' (event_sources of type 'pixel') and OMIT 'subtype' (Meta v18+ infers it; passing subtype: WEBSITE returns error 2654). (b) CUSTOM customer-list — pass subtype: 'CUSTOM' + customer_file_source; PII must be SHA-256 hashed before uploading users. After creation: build a lookalike with ads_create_lookalike_audience and apply the id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]).`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Audience name"),
        description: z.string().optional().describe("Audience description"),
        subtype: z
          .enum(["CUSTOM", "WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT"])
          .optional()
          .describe(
            "Audience subtype. OMIT (or pass 'WEBSITE') when 'rule' is set — for pixel-based audiences Meta infers the subtype and rejects an explicit one (error 2654); the tool drops it automatically. For non-rule flows: when omitted, defaults to 'CUSTOM' (customer-list), which also requires customer_file_source.",
          ),
        customer_file_source: z
          .enum([
            "USER_PROVIDED_ONLY",
            "PARTNER_PROVIDED_ONLY",
            "BOTH_USER_AND_PARTNER_PROVIDED",
          ])
          .optional()
          .describe("Required only when subtype = 'CUSTOM' (customer-list)."),
        retention_days: z.number().optional().describe("Retention period in days"),
        rule: z
          .string()
          .optional()
          .describe(
            "JSON rule for pixel/event-based audiences (WEBSITE). Shape: {inclusions:{operator:'or',rules:[{event_sources:[{id:'<pixel_id>',type:'pixel'}],retention_seconds:<n>,filter:{operator:'and',filters:[{field:'event',operator:'=',value:'<event_name>'}]}}]}}. When 'rule' is set, omit 'subtype'.",
          ),
        prefill: z.boolean().optional().describe("Whether to prefill with existing data (for WEBSITE)"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, description, subtype, customer_file_source, retention_days, rule, prefill }) => {
      const id = normalizeAccountId(account_id);

      const effectiveSubtype = rule ? undefined : (subtype ?? "CUSTOM");

      if (effectiveSubtype === "CUSTOM" && !customer_file_source) {
        throw new Error(
          "subtype 'CUSTOM' requires customer_file_source. Use one of: USER_PROVIDED_ONLY, PARTNER_PROVIDED_ONLY, BOTH_USER_AND_PARTNER_PROVIDED.",
        );
      }

      const body: Record<string, string | number | boolean> = { name };

      if (effectiveSubtype) body.subtype = effectiveSubtype;
      if (description) body.description = description;
      if (customer_file_source) body.customer_file_source = customer_file_source;
      if (retention_days !== undefined) body.retention_days = retention_days;
      if (rule) body.rule = rule;
      if (prefill !== undefined) body.prefill = prefill;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/customaudiences`,
        body,
      );

      const reportedType = effectiveSubtype ?? "WEBSITE (inferred from rule)";
      return {
        content: [
          {
            type: "text",
            text: `Custom audience created!\nID: ${result.id}\nName: ${name}\nType: ${reportedType}`,
          },
        ],
      };
    },
  );

  // ─── Create Lookalike Audience ────────────────────────────────
  server.registerTool(
    "ads_create_lookalike_audience",
    {
      description: `${WRITE_WARNING}Create a lookalike audience seeded by an existing custom audience. Source must have ~100+ matched users or Meta rejects the request. Ratio controls similarity vs. reach (0.01 = closest 1%, 0.20 = top 20% — bigger reach, lower similarity). After creation, apply the lookalike id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]). Lookalikes typically need ~24 h to compute users — id is returned immediately but reach starts at zero.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Lookalike audience name"),
        origin_audience_id: z.string().describe("Source custom audience ID"),
        ratio: z.number().min(0.01).max(0.20).describe("Lookalike ratio (0.01 = 1%, 0.20 = 20%)"),
        country: z.string().describe("Target country ISO code (e.g., CO, US, MX)"),
        description: z.string().optional(),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, origin_audience_id, ratio, country, description }) => {
      const accountPath = normalizeAccountId(account_id);
      const originAudienceIdValidated = validateMetaId(origin_audience_id, "audience");

      const body: Record<string, string | number | boolean> = {
        name,
        subtype: "LOOKALIKE",
        origin_audience_id: originAudienceIdValidated,
        lookalike_spec: JSON.stringify({
          ratio,
          country,
          type: "similarity",
        }),
      };

      if (description) body.description = description;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${accountPath}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Lookalike audience created!\nID: ${result.id}\nName: ${name}\nSource: ${originAudienceIdValidated}\nRatio: ${(ratio * 100).toFixed(0)}%\nCountry: ${country}`,
          },
        ],
      };
    },
  );

  // ─── Share Custom Audience ────────────────────────────────────
  server.registerTool(
    "ads_share_custom_audience",
    {
      description: `${WRITE_WARNING}Share a custom audience with one or more ad accounts under the same Business Manager. Both source and target accounts must belong to the same BM and the caller needs ads_management on each. Shareable subtypes: CUSTOM, LOOKALIKE, WEBSITE (engagement/offline-conversion audiences cannot be shared — Meta returns code 2655). Re-sharing with the same account is a no-op. After sharing, the target account can target the audience via ads_update_ad_set (targeting.custom_audiences=[{id}]).`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to share"),
        ad_account_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "Target ad account IDs (numeric or act_<id>). Must be in the same Business Manager as the audience owner.",
          ),
        relationship_type: z
          .array(z.string())
          .optional()
          .describe('Optional relationship tags (e.g. ["AGENCY"]).'),
      },
      annotations: { ...UPDATE },
    },
    async ({ audience_id, ad_account_ids, relationship_type }) => {
      const id = validateMetaId(audience_id, "audience");
      const numericAccounts = ad_account_ids.map((a) =>
        normalizeAccountId(a).slice("act_".length),
      );

      const body: Record<string, string | number | boolean> = {
        adaccounts: JSON.stringify(numericAccounts),
      };
      if (relationship_type?.length) {
        body.relationship_type = JSON.stringify(relationship_type);
      }

      const response = await metaApiClient.postForm<{ success?: boolean }>(
        `/${id}/adaccounts`,
        body,
      );

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the share for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} shared with ${numericAccounts.length} account(s): ${numericAccounts.join(", ")}`,
          },
        ],
      };
    },
  );

  // ─── Unshare Custom Audience ──────────────────────────────────
  server.registerTool(
    "ads_unshare_custom_audience",
    {
      description: `${WRITE_WARNING}Revoke a custom audience share from one or more ad accounts. Only removes the share relationship — the audience itself remains on the owner account. Use ads_get_audience_shared_accounts first to confirm which accounts currently have access.`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to unshare"),
        ad_account_ids: z
          .array(z.string())
          .min(1)
          .describe(
            "Ad account IDs to revoke (numeric or act_<id>).",
          ),
      },
      annotations: { ...UPDATE },
    },
    async ({ audience_id, ad_account_ids }) => {
      const id = validateMetaId(audience_id, "audience");
      const numericAccounts = ad_account_ids.map((a) =>
        normalizeAccountId(a).slice("act_".length),
      );

      const query = new URLSearchParams({
        adaccounts: JSON.stringify(numericAccounts),
      }).toString();

      const response = await metaApiClient.delete<{ success?: boolean }>(
        `/${id}/adaccounts?${query}`,
      );

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the unshare for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} unshared from ${numericAccounts.length} account(s): ${numericAccounts.join(", ")}`,
          },
        ],
      };
    },
  );

  // ─── Get Audience Shared Accounts ─────────────────────────────
  server.registerTool(
    "ads_get_audience_shared_accounts",
    {
      description:
        "List ad accounts that currently have shared access to a custom audience. Returns each account id + name. Use before ads_share_custom_audience / ads_unshare_custom_audience to audit the share set.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        limit: z.number().min(1).max(100).default(25),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, limit }) => {
      const id = validateMetaId(audience_id, "audience");

      const response = await metaApiClient.get<
        MetaApiResponse<{ account_id: string; id?: string; name?: string }>
      >(`/${id}/adaccounts`, { fields: "account_id,name", limit });

      const accounts = response.data ?? [];
      const text =
        accounts.length === 0
          ? "No shared accounts."
          : accounts
              .map(
                (a) =>
                  `• ${a.name ?? "(unnamed)"} (act_${a.account_id})`,
              )
              .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Audience ${id} is shared with ${accounts.length} account(s):\n\n${text}`,
          },
          { type: "text", text: JSON.stringify(accounts, null, 2) },
        ],
      };
    },
  );

  // ─── Delete Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_delete_custom_audience",
    {
      description: `${WRITE_WARNING}Permanently delete a custom audience from the ad account. Cannot be undone. To remove an audience from a single ad set without destroying it everywhere, prefer ads_update_ad_set with targeting.custom_audiences set to a different array (or omitted from a fresh targeting spec).`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ audience_id }) => {
      const id = validateMetaId(audience_id, "audience");
      const response = await metaApiClient.delete<{ success?: boolean }>(`/${id}`);

      if (response?.success !== true) {
        throw new Error(
          `Meta did not confirm the deletion for audience ${id}. Response: ${JSON.stringify(response)}`,
        );
      }

      return {
        content: [
          { type: "text", text: `Audience ${id} deleted successfully.` },
        ],
      };
    },
  );

  // ─── Update an audience (official name) ───────────────────────
  server.registerTool(
    "ads_update_custom_audience",
    {
      description:
        `${WRITE_WARNING}Rename a custom audience, change its description, or replace the rule of a website, app or engagement audience ` +
        "(the same JSON shape ads_create_custom_audience takes). Customer lists change their members with ads_update_custom_audience_users instead.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        rule: z.record(z.string(), z.unknown()).optional().describe("New rule, replacing the current one"),
      },
      annotations: { ...UPDATE },
    },
    async ({ audience_id, name, description, rule }) => {
      const id = validateNumericId(audience_id, "audience_id");
      if (name === undefined && description === undefined && rule === undefined) {
        throw new Error("Nothing to change: give name, description or rule.");
      }
      const audience = await metaApiClient.get<{ subtype?: string }>(`/${id}`, { fields: "id,name,subtype" });
      if (rule !== undefined && (audience.subtype === "CUSTOM" || audience.subtype === "LOOKALIKE")) {
        // Measured: Meta answers success to a rule on a customer list.
        throw new Error(`A rule applies to website, app and engagement audiences; audience ${id} is ${singleLine(audience.subtype, 30)}.`);
      }
      const body: Record<string, string> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (rule !== undefined) body.rule = JSON.stringify(rule);
      const unconfirmed = (reason: string) =>
        new Error(`Meta did not confirm the change to audience ${id} (${reason}): it may or may not have gone through. Read it with ads_get_audience_details.`);
      let answer: { success?: unknown };
      try {
        answer = await metaApiClient.postForm<{ success?: unknown }>(`/${id}`, body, { noRetry: true });
      } catch (err) {
        if (wasRefused(err)) throw err;
        throw unconfirmed(why(err));
      }
      if (answer?.success === false) throw new Error(`Meta answered that the change to audience ${id} was not applied.`);
      if (answer?.success !== true) throw unconfirmed("its answer did not say success");
      const updated = `Audience ${id} updated${rule !== undefined ? ", rule replaced" : ""}.`;
      let after: { name?: string; description?: string };
      try {
        after = scrubbed(await metaApiClient.get<{ name?: string; description?: string }>(`/${id}`, { fields: "name,description" }));
      } catch (err) {
        return { content: [{ type: "text", text: `${updated} It could not be read back (${why(err)}); ads_get_audience_details shows it.` }] };
      }
      return {
        content: [{
          type: "text",
          text: [
            updated,
            ...fence([`Name: ${singleLine(after.name, 200) || "(unnamed)"}`, ...(after.description ? [`Description: ${singleLine(after.description, 400)}`] : [])]),
          ].join("\n"),
        }],
      };
    },
  );

  // ─── Ad sets using an audience (official name) ────────────────
  server.registerTool(
    "ads_get_custom_audience_adsets",
    {
      description:
        "List the ad sets of an ad account that target a custom audience, and whether each includes or excludes it. " +
        `Meta has no list for this (measured), so the account's ad sets are read with their targeting, up to ${AUDIENCE_ADSETS_SCAN}; deleted ones are left out as Meta does. ` +
        "The account is the audience's own unless account_id says otherwise (a shared audience is used in other accounts too). Ad set names come inside an untrusted-content fence.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        account_id: z.string().optional().describe("Ad account whose ad sets to read; by default the audience's own"),
        limit: z.number().int().min(1).max(200).default(50).describe("Most ad sets to list"),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, account_id, limit }) => {
      const id = validateNumericId(audience_id, "audience_id");
      let account: string;
      if (account_id !== undefined) {
        account = normalizeAccountId(account_id);
      } else {
        const owner = await metaApiClient.get<{ account_id?: string }>(`/${id}`, { fields: "id,account_id" });
        if (!owner.account_id || !/^(act_)?\d{1,30}$/.test(owner.account_id)) {
          throw new Error(`Meta did not say which ad account audience ${id} belongs to; pass account_id.`);
        }
        account = normalizeAccountId(owner.account_id);
      }

      const { items, complete } = await readList<{
        id?: string; name?: string; campaign_id?: string; effective_status?: string;
        targeting?: { custom_audiences?: Array<{ id?: string }>; excluded_custom_audiences?: Array<{ id?: string }> };
      }>(
        `/${account}/adsets`,
        { fields: "id,name,campaign_id,effective_status,targeting{custom_audiences,excluded_custom_audiences}", limit: 200 },
        AUDIENCE_ADSETS_SCAN,
      );
      const using = items
        .map((a) => ({
          adset: a,
          use: (a.targeting?.custom_audiences ?? []).some((c) => c.id === id)
            ? "includes"
            : (a.targeting?.excluded_custom_audiences ?? []).some((c) => c.id === id) ? "excludes" : undefined,
        }))
        .filter((u): u is { adset: typeof u.adset; use: "includes" | "excludes" } => u.use !== undefined);
      const shown = using.slice(0, limit);
      const includes = using.filter((u) => u.use === "includes").length;
      const lines = [
        `${using.length} ad set${using.length === 1 ? "" : "s"} of ${account} use audience ${id}: ${includes} include${includes === 1 ? "s" : ""} it, ` +
          `${using.length - includes} exclude${using.length - includes === 1 ? "s" : ""} it (${items.length} ad sets read).`,
        ...(using.length > limit ? [`${using.length - limit} more not listed; raise limit to see them.`] : []),
        ...(complete ? [] : ["The account's ad sets could not all be read, so more may use it."]),
        ...(shown.length
          ? fence(shown.map(({ adset, use }) =>
            `• ${singleLine(adset.name, 100) || "(unnamed)"} — ad_set_id ${singleLine(adset.id, 30)} — ${singleLine(adset.effective_status, 30) || "status unknown"}` +
            ` — campaign_id ${singleLine(adset.campaign_id, 30)} — ${use}`))
          : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Add or remove customer-list users (official name) ───────
  server.registerTool(
    "ads_update_custom_audience_users",
    {
      description:
        `${WRITE_WARNING}Add people to a customer-list audience, or remove them, from their email, phone, name, birth date, location, gender, ` +
        "external id or mobile advertiser id. Each value is normalized and SHA-256 hashed on this server, the way Meta's customer-file guide " +
        "asks, before anything reaches Meta; values that already are SHA-256 hashes are kept as they are, which is the safest way to send them. " +
        "Values are never logged or returned: a row that cannot be used is reported by its number and field only. " +
        "Phones need their country code; with country US, a ZIP code keeps its first five digits and a state becomes its two-letter code. " +
        `Up to ${MAX_USERS} rows per call. Only for customer-list (CUSTOM) audiences.`,
      inputSchema: {
        audience_id: z.string().describe("Customer-list audience ID"),
        action: z.enum(["add", "remove"]),
        users: z
          .array(z.object({
            email: z.string().max(320).optional(),
            phone: z.string().max(64).optional(),
            first_name: z.string().max(100).optional(),
            last_name: z.string().max(100).optional(),
            first_initial: z.string().max(64).optional(),
            gender: z.string().max(64).optional().describe("m or f"),
            birth_year: z.string().max(64).optional(),
            birth_month: z.string().max(64).optional(),
            birth_day: z.string().max(64).optional(),
            city: z.string().max(100).optional(),
            state: z.string().max(100).optional().describe("A US state as its name or two-letter code, with country US"),
            zip: z.string().max(64).optional(),
            country: z.string().max(64).optional().describe("Two-letter ISO 3166 code"),
            external_id: z.string().max(256).optional().describe("The advertiser's own id for the person; sent unhashed, as Meta asks"),
            mobile_advertiser_id: z.string().max(64).optional().describe("Device advertising id; sent unhashed, as Meta asks"),
          }))
          .min(1)
          .max(MAX_USERS),
      },
      annotations: { ...DELETE },
    },
    async ({ audience_id, action, users }) => {
      const id = validateNumericId(audience_id, "audience_id");
      const audience = await metaApiClient.get<{ subtype?: string }>(`/${id}`, { fields: "id,subtype" });
      if (audience.subtype !== "CUSTOM") {
        // Measured: Meta accepts users into a website audience without complaint.
        throw new Error(`Audience ${id} is not a customer list (it is ${singleLine(audience.subtype, 30) || "of unknown type"}); people are added only to customer-list audiences.`);
      }
      const { schema, data, rejected } = buildCustomerPayload(users);
      const rejectedLines = rejected.slice(0, MAX_REJECTED_SHOWN).map((r) => `row ${r.row}: ${r.reason}`);
      const moreRejected = rejected.length > MAX_REJECTED_SHOWN ? [`and ${rejected.length - MAX_REJECTED_SHOWN} more rows`] : [];
      if (data.length === 0) throw new Error(`No row could be used: ${[...rejectedLines, ...moreRejected].join("; ")}.`);

      // The hashes go in the form body, never in a URL; removal is a POST
      // with method=DELETE, which Meta takes (measured). Meta's error text
      // could quote what was sent, so only its code comes back.
      const body: Record<string, string> = { payload: JSON.stringify({ schema, data }) };
      if (action === "remove") body.method = "DELETE";
      const what = action === "add" ? "addition" : "removal";
      const unconfirmed = (reason: string) => new Error(`Meta did not confirm the ${what} (${reason}): it may or may not have been applied.`);
      let result: unknown;
      try {
        result = await metaApiClient.postForm<unknown>(`/${id}/users`, body, { noRetry: true, withholdMessage: true });
      } catch (err) {
        if (wasRefused(err)) throw new Error(`Meta refused the ${what} (${why(err)}).`);
        throw unconfirmed(why(err));
      }
      const answer = result && typeof result === "object" ? (result as { num_received?: unknown; num_invalid_entries?: unknown }) : {};
      if (typeof answer.num_received !== "number") throw unconfirmed("its answer did not say how many rows it received");
      const received = answer.num_received;
      const invalid = typeof answer.num_invalid_entries === "number" ? answer.num_invalid_entries : undefined;
      const lines = [
        `Sent ${data.length} row${data.length === 1 ? "" : "s"} to ${action === "add" ? "add to" : "remove from"} audience ${id} (fields ${schema.join(", ")}): ` +
          `Meta received ${received}, and could not use ${invalid ?? "?"}.`,
        ...(rejected.length
          ? [`${rejected.length} row${rejected.length === 1 ? " was" : "s were"} not sent: ${[...rejectedLines, ...moreRejected].join("; ")}.`]
          : []),
        "Meta updates the audience's size over the next hours.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// Ad sets read per call to ads_get_custom_audience_adsets.
const AUDIENCE_ADSETS_SCAN = 4000;
// Meta takes up to 10,000 rows per request to /{audience_id}/users.
const MAX_USERS = 10_000;
const MAX_REJECTED_SHOWN = 20;
const fence = (lines: string[]) => [ADVERTISER_CONTENT_OPEN, ...lines, ADVERTISER_CONTENT_CLOSE];
// Meta's error can quote the hashed entries it rejected; those stay out.
const why = (err: unknown) =>
  singleLine((err instanceof Error ? err.message : String(err)).replace(/\b[0-9a-f]{64}\b/gi, "[hash]"), 240);
