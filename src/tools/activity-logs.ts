import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readList, scrubbed } from "../meta/read-list.js";
import { normalizeAccountId, validateNumericId } from "../utils/format.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { mentionsCredential } from "../utils/scrub-credentials.js";
import { READ } from "./_register.js";

// The categories Meta lists when given another one (measured on v26.0).
const CATEGORIES = ["ACCOUNT", "AD", "AD_KEYWORDS", "AD_SET", "AUDIENCE", "BID", "BUDGET", "CAMPAIGN", "DATE", "STATUS", "TARGETING"] as const;

const MAX_LIMIT = 500;

const FIELDS =
  "event_type,event_time,translated_event_type,object_id,object_type,object_name,actor_id,actor_name,application_id,application_name,extra_data";

// The activity log still uses Meta's old object names: a campaign is a
// CAMPAIGN_GROUP and an ad set a CAMPAIGN.
const OBJECT_LABELS: Record<string, string> = {
  CAMPAIGN_GROUP: "campaign",
  CAMPAIGN: "ad set",
  ADGROUP: "ad",
  ACCOUNT: "ad account",
};

interface Activity {
  event_type?: string;
  event_time?: string;
  translated_event_type?: string;
  object_id?: string;
  object_type?: string;
  object_name?: string;
  actor_id?: string;
  actor_name?: string;
  application_name?: string;
  extra_data?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// A day alone reads as the start of that day in UTC, or as its end for
// until, so a window from one day to another includes both. A day that does
// not exist (2026-02-30) is refused, not rolled into the next month.
function unixTime(value: string, name: string, endOfDay = false): number {
  const day = DAY.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  const realDay = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value;
  const ms = DAY.test(value)
    ? (realDay ? day + (endOfDay ? 86_399_000 : 0) : NaN)
    : INSTANT.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`${name} must be a date (2026-10-01, read as UTC) or a time with its offset (2026-10-01T12:00:00Z). Got: ${JSON.stringify(value).slice(0, 60)}`);
  }
  return Math.floor(ms / 1000);
}

// extra_data is free-form: any shape could carry a credential, so only what
// is plainly safe is shown, rather than chasing every shape a credential can
// take. Of extra_data, only old_value and new_value are read. A number or a
// boolean is shown. Text is shown only when short, free of the characters an
// assignment, a URL, an encoding or JSON needs, free of credential names and
// of anything shaped like a Meta token. Everything else is not shown.
const SAFE_TEXT = /^[^=%&?#@\\"'`{}[\]<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{0,120}$/u;
const META_TOKEN = /EAA[A-Za-z0-9]{20,}/;

function shownValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    // Flattened like every other third-party value, so it cannot leave its
    // line or the fence; @ is refused because a URL can carry user:password@.
    const text = singleLine(scrubbed(value), 120);
    return SAFE_TEXT.test(text) && !mentionsCredential(text) && !META_TOKEN.test(text) ? JSON.stringify(text) : "(not shown)";
  }
  return "(structured value not shown)";
}

function change(extra: string | undefined): string {
  if (!extra) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(extra);
  } catch {
    return "details not shown";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "details not shown";
  const record = parsed as Record<string, unknown>;
  if ("old_value" in record && "new_value" in record) return `from ${shownValue(record.old_value)} to ${shownValue(record.new_value)}`;
  if ("new_value" in record) return `set to ${shownValue(record.new_value)}`;
  return "";
}

function activityLine(a: Activity): string {
  const type = a.object_type ?? "";
  const label = OBJECT_LABELS[type] ?? (singleLine(type, 40) || "object");
  const what = a.translated_event_type ? `${singleLine(a.translated_event_type, 100)} (${singleLine(a.event_type, 60)})` : singleLine(a.event_type, 60);
  return [
    `• ${singleLine(a.event_time, 30)}`,
    what || "unknown event",
    `${label} ${singleLine(a.object_name, 100) || "(unnamed)"} (${singleLine(a.object_id, 30)})`,
    `by ${singleLine(a.actor_name, 80) || "unknown"} (${singleLine(a.actor_id, 30)})` + (a.application_name ? ` via ${singleLine(a.application_name, 80)}` : ""),
    ...(change(a.extra_data) ? [change(a.extra_data)] : []),
  ].join(" — ");
}

export function registerActivityLogTools(server: McpServer): void {
  server.registerTool(
    "ads_account_get_activity_logs",
    {
      description:
        "Read an ad account's activity log, as Ads Manager's history shows it: who changed what and when " +
        "(budgets, status, targeting, bids, creation), with the old and new values. " +
        "Optionally narrowed by a time window (UTC dates), a category, one campaign, ad set or ad (object_id) and one person (user_id). " +
        "Newest first. Names and values come inside an untrusted-content fence.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID (with or without 'act_' prefix)"),
        since: z.string().optional().describe("Start of the window: 2026-10-01 (from the start of that day, UTC) or 2026-10-01T12:00:00Z"),
        until: z.string().optional().describe("End of the window: 2026-10-28 (to the end of that day, UTC) or 2026-10-28T12:00:00Z"),
        category: z.enum(CATEGORIES).optional().describe("Only one kind of change"),
        object_id: z.string().optional().describe("Only changes to this campaign, ad set or ad"),
        user_id: z.string().optional().describe("Only changes made by this person (actor_id in earlier results)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(50).describe("Most changes to list"),
      },
      annotations: { ...READ },
    },
    async ({ account_id, since, until, category, object_id, user_id, limit }) => {
      const id = normalizeAccountId(account_id);
      const params: Record<string, string | number> = { fields: FIELDS, limit: Math.min(limit, 100) };
      const from = since === undefined ? undefined : unixTime(since, "since");
      const to = until === undefined ? undefined : unixTime(until, "until", true);
      if (from !== undefined && to !== undefined && from > to) throw new Error("since must not be after until.");
      if (from !== undefined) params.since = from;
      if (to !== undefined) params.until = to;
      if (category) params.category = category;
      if (object_id !== undefined) params.oid = validateNumericId(object_id, "object_id");
      if (user_id !== undefined) params.uid = validateNumericId(user_id, "user_id");

      const { items, complete } = await readList<Activity>(`/${id}/activities`, params, limit);
      const shown = items.slice(0, limit);
      const lines = [
        shown.length === 0
          ? `No changes on ${id} match.`
          : `${shown.length} change${shown.length === 1 ? "" : "s"} on ${id}, newest first.`,
        ...(!complete || items.length > limit
          ? [`Meta lists more changes than these; ${limit < MAX_LIMIT ? "raise limit or " : ""}narrow the window (since, until) to see them.`]
          : []),
        ...(shown.length ? [ADVERTISER_CONTENT_OPEN, ...shown.map(activityLine), ADVERTISER_CONTENT_CLOSE] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
