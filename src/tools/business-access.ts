import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { metaApiClient } from "../meta/client.js";
import { wasRefused } from "../meta/errors.js";
import type { AssignedUser, Business, BusinessUser, MetaApiResponse, SystemUser } from "../meta/types/index.js";
import { normalizeAccountId } from "../utils/format.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { READ, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";

const ASSET_TYPES = ["ad_account", "page", "pixel"] as const;
type AssetType = (typeof ASSET_TYPES)[number];
const ROLES = ["admin", "editor", "moderator", "advertiser", "analyst"] as const;
type Role = (typeof ROLES)[number];

// The task sets behind the roles of Meta's own panel, most access first so the
// first role a user's tasks cover is the one they hold. Meta reads tasks back
// unpacked (an ad account advertiser also shows DRAFT), so a role is matched
// by inclusion, never by equality.
const ROLE_TASKS: Record<AssetType, Partial<Record<Role, readonly string[]>>> = {
  ad_account: {
    admin: ["MANAGE", "ADVERTISE", "ANALYZE"],
    advertiser: ["ADVERTISE", "ANALYZE"],
    analyst: ["ANALYZE"],
  },
  page: {
    admin: ["MANAGE", "CREATE_CONTENT", "MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"],
    editor: ["CREATE_CONTENT", "MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"],
    moderator: ["MODERATE", "MESSAGING", "ADVERTISE", "ANALYZE"],
    advertiser: ["ADVERTISE", "ANALYZE"],
    analyst: ["ANALYZE"],
  },
  pixel: {
    admin: ["EDIT", "UPLOAD", "ADVERTISE", "ANALYZE"],
    advertiser: ["ADVERTISE", "ANALYZE"],
    analyst: ["ANALYZE"],
  },
};

const ASSET_LABEL: Record<AssetType, string> = { ad_account: "ad account", page: "Page", pixel: "pixel" };
const MAX_BUSINESSES = 25;
const MAX_USERS = 1000;
// Meta can send empty pages that still go on, so pages are bounded apart from items.
const MAX_PAGES = 20;

const assetTypeInput = z.enum(ASSET_TYPES).describe("ad_account, page or pixel (a pixel is a dataset in Events Manager).");
const assetIdInput = z.string().describe("Ad account id (with or without act_), Page id or pixel id.");
const userIdInput = z
  .string()
  .describe("The business-scoped user_id from ads_get_business_users or ads_get_asset_users, not a personal Facebook id.");
const businessIdInput = z
  .string()
  .optional()
  .describe(
    "The Business Manager whose members get or lose access: for an agency, its own Business Manager, not the client's. " +
      "Can be left out only when the token sees a single Business Manager.",
  );

function numericId(value: string, kind: string): string {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid Meta ${kind}: must be numeric. Got: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

function assetPath(type: AssetType, id: string): string {
  return type === "ad_account" ? `/${normalizeAccountId(id)}` : `/${numericId(id, `${type} id`)}`;
}

// Page and pixel ids look alike and share the /assigned_users edge, so the
// asset is first read with fields only its own kind has. Meta refuses a field
// a node lacks (measured live), so an id of the other kind is never written to.
// An act_ id names only an ad account and needs no check.
const KIND_FIELDS: Partial<Record<AssetType, string>> = {
  page: "id,category,fan_count",
  pixel: "id,owner_business,last_fired_time",
};

async function checkAssetKind(type: AssetType, path: string): Promise<void> {
  const fields = KIND_FIELDS[type];
  if (!fields) return;
  let node: { id?: string };
  try {
    node = await metaApiClient.get<{ id?: string }>(path, { fields });
  } catch (err) {
    if (!(err instanceof McpError && err.code === ErrorCode.InvalidParams)) throw err;
    throw new McpError(
      ErrorCode.InvalidParams,
      `Meta would not read ${path.slice(1)} as a ${ASSET_LABEL[type]} (${singleLine(err.message, 200)}). Check asset_type and asset_id.`,
    );
  }
  if (node.id !== path.slice(1)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Meta answered for another object than ${ASSET_LABEL[type]} ${path.slice(1)}. Check asset_type and asset_id.`,
    );
  }
}

interface ListRead<T> {
  items: T[];
  /** True only when Meta ended the list itself: anything else proves nobody's absence. */
  complete: boolean;
  total?: number;
}

/**
 * Every page of a Graph list, up to `max` items. Meta ends a list only by
 * leaving `next` out (a page can be empty and still have one), so a list is
 * complete only then. A next page without a cursor, a cursor seen before, or
 * running into a limit all leave it incomplete.
 */
async function readList<T>(path: string, params: Record<string, string | number>, max: number): Promise<ListRead<T>> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let total: number | undefined;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES && items.length < max; page++) {
    const res = await metaApiClient.get<MetaApiResponse<T> & { summary?: { total_count?: number } }>(
      path,
      after === undefined ? params : { ...params, after },
    );
    total ??= res.summary?.total_count;
    items.push(...(res.data ?? []));
    if (!res.paging?.next) return { items, complete: true, total };
    after = res.paging.cursors?.after;
    if (!after || cursors.has(after)) break;
    cursors.add(after);
  }
  return { items, complete: false, total };
}

/** The Business Manager to act through: the one given, or the token's only one. */
async function resolveBusinessId(businessId: string | undefined): Promise<string> {
  if (businessId !== undefined) return numericId(businessId, "business_id");
  const { items: businesses, complete } = await readList<Business>(
    "/me/businesses",
    { fields: "id,name", limit: MAX_BUSINESSES },
    MAX_BUSINESSES,
  );
  if (complete && businesses.length === 1) return numericId(businesses[0].id, "business_id");
  if (complete && businesses.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "This token sees no Business Manager, so there are no members to manage.");
  }
  throw new McpError(ErrorCode.InvalidParams, [
    `This token sees ${complete ? "" : "at least "}${count(businesses.length, "Business Manager", "Business Managers")}. ` +
      "Ask which one to act through and pass its business_id.",
    ADVERTISER_CONTENT_OPEN,
    ...businesses.map((b) => `• ${singleLine(b.name, 80) || "(unnamed)"} — business_id ${singleLine(b.id, 30)}`),
    ADVERTISER_CONTENT_CLOSE,
  ].join("\n"));
}

async function assignedUsers(path: string, business: string): Promise<{ users: AssignedUser[]; complete: boolean }> {
  const { items, complete } = await readList<AssignedUser>(
    `${path}/assigned_users`,
    { business, fields: "id,name,user_type,tasks", limit: 100 },
    MAX_USERS,
  );
  return { users: items, complete };
}

type Seen = { state: "present"; tasks?: string[] } | { state: "absent" } | { state: "unknown"; why: string };

/** What Meta holds for one user on an asset. Only a list read to the end shows an absence. */
async function observe(path: string, business: string, user: string): Promise<Seen> {
  try {
    const { users, complete } = await assignedUsers(path, business);
    const found = users.find((u) => u.id === user);
    if (found) return { state: "present", tasks: found.tasks };
    return complete ? { state: "absent" } : { state: "unknown", why: "Meta's list of users on this asset could not be read to the end" };
  } catch {
    return { state: "unknown", why: "the read-back failed" };
  }
}

/** A write whose answer never came back may still have gone through: say so, with what Meta shows now. */
async function lostAnswer(err: unknown, what: string, type: AssetType, path: string, business: string, user: string): Promise<Error> {
  const seen = await observe(path, business, user);
  let now: string;
  if (seen.state === "present") {
    now = `Meta now shows user ${user} with role ${roleOf(type, seen.tasks)}, tasks ${taskList(seen.tasks)} (read back from Meta).`;
  } else if (seen.state === "absent") {
    now = `Meta now lists no access for user ${user} on this asset (read back from Meta).`;
  } else {
    now = `What Meta now holds could not be confirmed: ${seen.why}. Check with ads_get_asset_users.`;
  }
  const reason = singleLine(err instanceof Error ? err.message : String(err), 200);
  return new Error(`Meta's answer to ${what} was lost (${reason}), so the change may or may not have been applied. ${now}`);
}

function roleOf(type: AssetType, tasks: readonly string[] = []): string {
  const held = new Set(tasks);
  const match = Object.entries(ROLE_TASKS[type]).find(([, needed]) => needed.every((task) => held.has(task)));
  return match?.[0] ?? "custom";
}

const taskList = (tasks: readonly string[] = []) => singleLine(tasks.join(", "), 400) || "none";

function userKind(userType: string | undefined): string {
  if (userType === "system_user") return "system user";
  if (userType === "business_user") return "person";
  return singleLine(userType, 30) || "unknown type";
}

function assignedLine(type: AssetType, user: AssignedUser): string {
  return `• ${singleLine(user.name, 80) || "(unnamed)"} — user_id ${singleLine(user.id, 30)} — ${userKind(user.user_type)}` +
    ` — role ${roleOf(type, user.tasks)} — tasks ${taskList(user.tasks)}`;
}

const fence = (lines: string[]) => [ADVERTISER_CONTENT_OPEN, ...lines, ADVERTISER_CONTENT_CLOSE];
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function registerBusinessAccessTools(server: McpServer): void {
  // ─── Business Manager members ─────────────────────────────────
  server.registerTool(
    "ads_get_business_users",
    {
      description:
        "List the people and system users of a Business Manager, with the business-scoped user_id that ads_assign_user_to_asset takes. " +
        "People come with their email and Business Manager role (ADMIN or EMPLOYEE). " +
        "Meta lists only the people it shows this app; when it holds more, the result says how many are missing.",
      inputSchema: { business_id: businessIdInput },
      annotations: { ...READ },
    },
    async ({ business_id }) => {
      const business = await resolveBusinessId(business_id);
      const { items: people, complete: allPeople, total } = await readList<BusinessUser>(
        `/${business}/business_users`,
        { fields: "id,name,email,role", summary: "total_count", limit: 100 },
        MAX_USERS,
      );

      const notes: string[] = [];
      let systemUsers: SystemUser[] = [];
      let allSystemUsers = false;
      try {
        const read = await readList<SystemUser>(`/${business}/system_users`, { fields: "id,name,role", limit: 100 }, MAX_USERS);
        systemUsers = read.items;
        allSystemUsers = read.complete;
        if (!read.complete) notes.push("Meta lists more system users than these; they could not all be read.");
      } catch (err) {
        notes.push(`System users could not be read: ${singleLine(err instanceof Error ? err.message : String(err), 200)}`);
      }

      if (!allPeople) {
        notes.push(`Meta lists more people than these${typeof total === "number" ? ` (${total} in all)` : ""}; they could not all be read.`);
      } else if (typeof total === "number" && total > people.length) {
        notes.push(
          `Meta returned ${people.length} of the ${total} people in this Business Manager: it withholds the rest from this app, ` +
            "which happens while the app lacks Advanced Access to business_management. " +
            "Anyone who already has access to some asset is listed, with the user_id to use, by ads_get_asset_users.",
        );
      }

      const lines = [
        ...people.map((u) =>
          `• ${singleLine(u.name, 80) || "(unnamed)"} — user_id ${singleLine(u.id, 30)} — person — role ${singleLine(u.role, 30) || "unknown"}` +
            (u.email ? ` — email ${singleLine(u.email, 120)}` : "")),
        ...systemUsers.map((u) =>
          `• ${singleLine(u.name, 80) || "(unnamed)"} — user_id ${singleLine(u.id, 30)} — system user — role ${singleLine(u.role, 30) || "unknown"}`),
      ];
      const soFar = (read: boolean) => (read ? "" : " read so far");
      const text = [
        `Business Manager ${business}: ${count(people.length, "person", "people")}${soFar(allPeople)} ` +
          `and ${count(systemUsers.length, "system user", "system users")}${soFar(allSystemUsers)}.`,
        ...notes,
        ...(lines.length ? fence(lines) : ["No people or system users returned."]),
      ];
      return { content: [{ type: "text", text: text.join("\n") }] };
    },
  );

  // ─── Who has access to an asset ───────────────────────────────
  server.registerTool(
    "ads_get_asset_users",
    {
      description:
        "List who has access to an ad account, Page or pixel through a Business Manager: each person or system user with their user_id, " +
        "the role their tasks amount to (admin, editor, moderator, advertiser, analyst, or custom when they match none) and the exact tasks. " +
        "Use it before ads_assign_user_to_asset or ads_remove_user_from_asset to see the current state.",
      inputSchema: { asset_type: assetTypeInput, asset_id: assetIdInput, business_id: businessIdInput },
      annotations: { ...READ },
    },
    async ({ asset_type, asset_id, business_id }) => {
      const path = assetPath(asset_type, asset_id);
      const business = await resolveBusinessId(business_id);
      await checkAssetKind(asset_type, path);
      const { users, complete } = await assignedUsers(path, business);
      const label = `${ASSET_LABEL[asset_type]} ${path.slice(1)}`;
      let header: string;
      if (!complete) {
        header = `${count(users.length, "user", "users")} of Business Manager ${business} with access to ${label} read so far: ` +
          "Meta's list could not be read to the end, so there may be more.";
      } else if (users.length) {
        header = `${count(users.length, "user", "users")} of Business Manager ${business} with access to ${label}.`;
      } else {
        header = `No users of Business Manager ${business} have access to ${label}.`;
      }
      const text = [header, ...(users.length ? fence(users.map((u) => assignedLine(asset_type, u))) : [])];
      return { content: [{ type: "text", text: text.join("\n") }] };
    },
  );

  // ─── Give or change access ────────────────────────────────────
  server.registerTool(
    "ads_assign_user_to_asset",
    {
      description:
        `${WRITE_WARNING}Give a Business Manager member access to an ad account, Page or pixel, or change the role they have there ` +
        "(calling again with another role replaces it). The person or system user must already be in the Business Manager: " +
        "find their user_id with ads_get_business_users, or with ads_get_asset_users when they already have access to another asset. " +
        "Roles are Meta's: ad_account admin | advertiser | analyst; page admin | editor | moderator | advertiser | analyst; pixel admin | advertiser | analyst. " +
        "admin gives full control of the asset, including adding and removing other people. " +
        "Confirm the person, the asset and the role with the human before calling. Needs the caller to be an admin of the Business Manager. " +
        "The result reports what Meta holds afterwards.",
      inputSchema: {
        asset_type: assetTypeInput,
        asset_id: assetIdInput,
        user_id: userIdInput,
        role: z.enum(ROLES).describe("ad_account: admin | advertiser | analyst. page: admin | editor | moderator | advertiser | analyst. pixel: admin | advertiser | analyst."),
        business_id: businessIdInput,
      },
      // Changing a role can take access away, so this counts as destructive.
      annotations: { ...UPDATE, destructiveHint: true },
    },
    async ({ asset_type, asset_id, user_id, role, business_id }) => {
      const path = assetPath(asset_type, asset_id);
      const user = numericId(user_id, "user_id");
      const tasks = ROLE_TASKS[asset_type][role];
      if (!tasks) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `There is no ${role} role on a ${ASSET_LABEL[asset_type]}. Choose one of: ${Object.keys(ROLE_TASKS[asset_type]).join(", ")}.`,
        );
      }
      const business = await resolveBusinessId(business_id);
      await checkAssetKind(asset_type, path);
      const label = `${ASSET_LABEL[asset_type]} ${path.slice(1)}`;
      const what = `giving user ${user} the ${role} role on ${label}`;

      let response: { success?: boolean } | undefined;
      try {
        response = await metaApiClient.postForm<{ success?: boolean }>(`${path}/assigned_users`, {
          user,
          tasks: JSON.stringify(tasks),
        });
      } catch (err) {
        if (wasRefused(err)) throw err;
        throw await lostAnswer(err, what, asset_type, path, business, user);
      }
      if (response?.success !== true) {
        throw new Error(`Meta did not confirm ${what}. Response: ${JSON.stringify(response)}`);
      }

      const lines = [`Meta accepted the ${role} role (${tasks.join(", ")}) for user ${user} on ${label}.`];
      const seen = await observe(path, business, user);
      if (seen.state === "present") {
        lines.push(`User ${user} now holds role ${roleOf(asset_type, seen.tasks)}, tasks ${taskList(seen.tasks)} (read back from Meta).`);
      } else if (seen.state === "absent") {
        lines.push(`User ${user} is not listed in Meta's read-back for Business Manager ${business}; check with ads_get_asset_users.`);
      } else {
        lines.push(`The change was accepted, but it could not be confirmed: ${seen.why}. Check with ads_get_asset_users.`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Take access away ─────────────────────────────────────────
  server.registerTool(
    "ads_remove_user_from_asset",
    {
      description:
        `${WRITE_WARNING}Take away a Business Manager member's access to an ad account, Page or pixel. ` +
        "They stay in the Business Manager and keep their access to other assets. " +
        "Confirm the person and the asset with the human before calling. Needs the caller to be an admin of the Business Manager. " +
        "The result reports whether Meta still lists them.",
      inputSchema: { asset_type: assetTypeInput, asset_id: assetIdInput, user_id: userIdInput, business_id: businessIdInput },
      annotations: { ...DELETE },
    },
    async ({ asset_type, asset_id, user_id, business_id }) => {
      const path = assetPath(asset_type, asset_id);
      const user = numericId(user_id, "user_id");
      const business = await resolveBusinessId(business_id);
      await checkAssetKind(asset_type, path);
      const label = `${ASSET_LABEL[asset_type]} ${path.slice(1)}`;
      const what = `removing user ${user} from ${label}`;

      let response: { success?: boolean } | undefined;
      try {
        response = await metaApiClient.delete<{ success?: boolean }>(`${path}/assigned_users`, { user });
      } catch (err) {
        if (wasRefused(err)) throw err;
        throw await lostAnswer(err, what, asset_type, path, business, user);
      }
      if (response?.success !== true) {
        throw new Error(`Meta did not confirm ${what}. Response: ${JSON.stringify(response)}`);
      }

      const lines = [`Meta accepted ${what}.`];
      const seen = await observe(path, business, user);
      if (seen.state === "present") {
        lines.push(`Meta still lists user ${user} with tasks ${taskList(seen.tasks)}. Its reads can lag behind a write: check again with ads_get_asset_users.`);
      } else if (seen.state === "absent") {
        lines.push(`User ${user} no longer has access (read back from Meta).`);
      } else {
        lines.push(`The removal was accepted, but it could not be confirmed: ${seen.why}. Check with ads_get_asset_users.`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
