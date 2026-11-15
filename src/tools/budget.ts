import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { wasRefused } from "../meta/errors.js";
import { scrubbed } from "../meta/read-list.js";
import { MINOR_UNIT_NOTE, formatMinorAmount } from "../meta/currency.js";
import {
  INCREASE_TYPES,
  KIND_LABEL,
  NOT_IN_BUDGET_FIELDS,
  SCHEDULE_FIELDS,
  canStillStart,
  checkConflicts,
  checkIncrease,
  checkWindow,
  describeSchedule,
  formatInstant,
  formatWindow,
  listSchedules,
  listSchedulesForWrite,
  nextUsableStart,
  parseIncrease,
  parseSchedule,
  readAccount,
  readOwner,
  readSchedule,
  readTarget,
  requireDailyBudget,
  sameValues,
  scheduleStatus,
  fromMeta,
  untrustedDetail,
  type AccountInfo,
  type BudgetTarget,
  type CallScope,
  type IncreaseType,
  type Schedule,
} from "../meta/budget-schedule.js";
import { validateNumericId } from "../utils/format.js";
import { instantSeconds } from "../utils/time.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CREATE, DELETE, READ, UPDATE, WRITE_WARNING } from "./_register.js";

type Values = Omit<Schedule, "id" | "objectId">;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const text = (lines: Array<string | false | undefined>) => ({
  content: [{ type: "text" as const, text: lines.filter((line): line is string => typeof line === "string" && line !== "").join("\n") }],
});

// A write here is sent once, and neither waits on rate limits nor for an
// answer longer than this: a period has to reach Meta before it starts, and
// every start is checked against the clock to be at least 2 minutes away just
// before the first write.
const WRITE_BOUND = { noRetry: true, timeoutMs: 20_000 } as const;

// From the first write on, the answer has to come back before the agent's
// client stops waiting (the MCP SDK's client gives up after 60 s by default):
// every call from then on shares this much time, each is sent with what is
// left (at most WRITE_BOUND), and one that would not fit is not sent.
const AFTER_WRITE_MS = 45_000;
const MIN_CALL_MS = 3_000;

export class Deadline {
  private readonly at = Date.now() + AFTER_WRITE_MS;

  /** The scope for the next call, or undefined when it would not fit. */
  scope(): CallScope | undefined {
    const left = this.at - Date.now();
    return left >= MIN_CALL_MS ? { noRetry: true, timeoutMs: Math.min(WRITE_BOUND.timeoutMs, left) } : undefined;
  }

  hasRoomFor(calls: number): boolean {
    return this.at - Date.now() >= calls * MIN_CALL_MS;
  }
}

/** A call that was not sent because the time for this answer had run out. */
class OutOfTime extends Error {
  constructor() {
    super("there was not enough time left in this answer to send it");
  }
}

// A replacement keeps this much lead, for itself and for the original it may
// have to put back: the shortest lead Meta was seen to accept for a new
// period (6 minutes, measured 2026-11-15) plus the two bounded writes before
// a restore can go out, rounded up.
const REPLACE_LEAD = 8 * 60;

const INCREASE_NOT_TOTAL =
  "budget_value is an INCREASE ADDED to the daily budget during the window, NOT the total: a daily budget of USD 100.00 with ABSOLUTE 30000 makes the daily budget USD 400.00 during the window. Like any daily budget, that is what Meta aims to spend, not a cap on a day's spend. " +
  "To reach a total T on a daily budget D: with ABSOLUTE send T − D (in the minor unit); with MULTIPLIER send the percentage 100 × (T − D) / D, a whole number, so round it and check the dry run's total.";

const RULES =
  "Meta's rules, checked here before anything is sent: only daily budgets (not lifetime); the increase goes where the budget is (the campaign with Advantage+ campaign budget, otherwise each ad set); times on a quarter hour (:00, :15, :30, :45), at least 3 hours long, starting in the future; an increase of at most 8 × the daily budget (MULTIPLIER at most 800); periods on one campaign or ad set cannot overlap or mix ABSOLUTE with MULTIPLIER; at most 50 per campaign or ad set.";

const targetInput = {
  campaign_id: z.string().optional().describe("Campaign that holds the daily budget (Advantage+ campaign budget). Give this or ad_set_id."),
  ad_set_id: z.string().optional().describe("Ad set that holds its own daily budget (a campaign without Advantage+ campaign budget). Give this or campaign_id."),
};

const amountInput = z.union([z.number().int().positive(), z.string().regex(/^\d{1,15}$/)]);
const timeInput = z.union([z.string(), z.number().int()]);
const VALUE_NOTE = `The INCREASE, not the total. For ABSOLUTE, the amount added ${MINOR_UNIT_NOTE}. For MULTIPLIER, a whole percentage of the daily budget added (50 = +50%, 100 doubles it, 800 at most).`;
const TYPE_NOTE = "ABSOLUTE = an amount added to the daily budget (unit: see budget_value). MULTIPLIER = a percentage of the daily budget added to it. One campaign or ad set uses one of the two for all its periods.";
const START_NOTE = "Start of the window: a time with its offset (2026-11-20T10:00:00-05:00) or Unix seconds. On a quarter hour (:00, :15, :30, :45) and in the future. A date alone is refused.";
const END_NOTE = "End of the window, in the same forms, on a quarter hour and at least 3 hours after the start.";
const DRY_RUN_NOTE = "true = check everything and show the result (the increase and the daily budget during the window in money, the window in the account's time zone) without changing anything. Use it first and confirm the total with the person.";

function pickTarget(campaignId: unknown, adSetId: unknown): { kind: "campaign" | "ad_set"; id: string } {
  const given = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (given(campaignId) === given(adSetId)) {
    throw new Error("Give exactly one of campaign_id or ad_set_id: the one that holds the daily budget. With Advantage+ campaign budget it is the campaign; otherwise each ad set holds its own.");
  }
  return given(campaignId)
    ? { kind: "campaign", id: validateNumericId(campaignId as string, "campaign_id") }
    : { kind: "ad_set", id: validateNumericId(adSetId as string, "ad_set_id") };
}

function parseType(value: unknown): IncreaseType {
  if (value === "ABSOLUTE" || value === "MULTIPLIER") return value;
  throw new Error(`budget_value_type must be ABSOLUTE or MULTIPLIER. Got: ${JSON.stringify(value)?.slice(0, 40)}`);
}

const bodyFor = (v: Values) => ({ budget_value: String(v.value), budget_value_type: v.type, time_start: v.start, time_end: v.end });

/** A create whose answer did not arrive and whose period was not found: it may or may not exist. `cause` is what failed. */
class LostCreate extends Error {
  constructor(readonly cause: unknown) {
    super("Meta's answer did not arrive");
  }
}

// The id of a period this call created and whose answer did not arrive: one
// not listed before the write (a period deleted since stays in `before`, as a
// stale read can still show it), with exactly the values sent, in a list known
// to be whole with every row read. Two of them would mean someone else is
// writing too, so neither is claimed.
async function findCreated(objectId: string, sent: Values, before: readonly Schedule[], deadline: Deadline): Promise<string | undefined> {
  const known = new Set(before.map((s) => s.id));
  try {
    const { schedules, complete, unreadable, repeating } = await listSchedules(objectId, () => deadline.scope());
    const matches = schedules.filter((s) => !known.has(s.id) && sameValues(s, sent));
    return complete && unreadable === 0 && repeating.length === 0 && matches.length === 1 ? matches[0].id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POST /{campaign or ad set}/budget_schedules, sent once and within the
 * deadline. A refusal is thrown as is (nothing was written), and OutOfTime
 * when there was no time to send it. A lost answer is looked for among the
 * periods; if it is not there, LostCreate.
 */
async function createPeriod(objectId: string, values: Values, before: readonly Schedule[], deadline: Deadline): Promise<{ id: string; lost?: unknown }> {
  const scope = deadline.scope();
  if (!scope) throw new OutOfTime();
  let lost: unknown;
  try {
    const answer = await fromMeta(() => metaApiClient.postForm<{ id?: unknown }>(`/${objectId}/budget_schedules`, bodyFor(values), scope));
    if (typeof answer?.id === "string" && /^\d{1,30}$/.test(answer.id)) return { id: answer.id };
    lost = new Error("its answer did not carry the new id");
  } catch (err) {
    if (wasRefused(err)) throw err;
    lost = err;
  }
  const found = await findCreated(objectId, values, before, deadline);
  if (found) return { id: found, lost };
  throw new LostCreate(lost);
}

async function readBack(id: string, deadline: Deadline): Promise<Schedule | undefined> {
  const scope = deadline.scope();
  if (!scope) return undefined;
  try {
    return parseSchedule(scrubbed(await metaApiClient.get<unknown>(`/${id}`, { fields: SCHEDULE_FIELDS }, scope)));
  } catch {
    return undefined;
  }
}

function readBackLine(after: Schedule | undefined, sent: Values): string | undefined {
  if (!after) return "It could not be read back, so the lines above are what was sent. Check with ads_get_budget_schedules.";
  return sameValues(after, sent) ? undefined : "Meta holds different values from the ones sent; the lines above are what Meta holds.";
}

async function deletePeriod(id: string, unconfirmed: (cause: unknown) => Error, refusedText: string, deadline: Deadline): Promise<void> {
  const scope = deadline.scope();
  if (!scope) throw new McpError(ErrorCode.InvalidRequest, `${refusedText} ${new OutOfTime().message}.`);
  let answer: { success?: unknown };
  try {
    answer = await fromMeta(() => metaApiClient.delete<{ success?: unknown }>(`/${id}`, undefined, scope));
  } catch (err) {
    if (wasRefused(err)) throw new McpError((err as McpError).code, `${refusedText}${untrustedDetail(err)}`);
    throw unconfirmed(err);
  }
  if (answer?.success !== true) throw unconfirmed(new Error("its answer did not say success"));
}

/** Re-checks a window against the clock just before the first write, so slow reads cannot carry a stale "now". */
function recheckWindow(values: Values): number {
  const now = nowSeconds();
  try {
    checkWindow(values.start, values.end, now);
  } catch (err) {
    throw new Error(`Nothing was changed: by the time the checks were done, the window no longer fits. ${err instanceof Error ? err.message : String(err)}`);
  }
  return now;
}

const targetLabel = (target: Pick<BudgetTarget, "kind" | "id">) => `${KIND_LABEL[target.kind]} ${target.id}`;

/** The create call that makes this period, for an answer that has to leave it to the agent. */
const createCall = (target: Pick<BudgetTarget, "kind" | "id">, v: Values) =>
  `ads_create_budget_schedule with ${target.kind === "ad_set" ? "ad_set_id" : "campaign_id"} ${target.id}, budget_value ${v.value}, budget_value_type ${v.type}, time_start ${v.start} and time_end ${v.end}`;

/**
 * What to tell an agent that asked to change a period in progress. Such a
 * period cannot be replaced safely, and the two steps that would change it
 * delete a running increase first: they are only advised when the new period
 * passes every check here, which are the same as for a create.
 */
async function inProgressAdvice(id: string, old: Schedule, given: Partial<Values>, now: number): Promise<string> {
  const head = `Budget schedule ${id} is in progress, so it is not changed here. Meta cannot edit a period, and one that has started cannot be put back with its own start: a replacement that Meta refused would lose the increase.`;
  const objectId = old.objectId as string;
  const values: Values = {
    value: given.value ?? old.value,
    type: given.type ?? old.type,
    start: given.start ?? nextUsableStart(now),
    end: given.end ?? old.end,
  };
  let owner: BudgetTarget;
  let account: AccountInfo;
  let daily: number;
  try {
    checkWindow(values.start, values.end, now);
    owner = await readOwner(objectId);
    daily = requireDailyBudget(owner);
    account = await readAccount(owner.accountId);
    checkIncrease(daily, values.type, values.value, account.currency);
    const existing = await listSchedulesForWrite(objectId);
    // The reads took time: the start is worked out again from the clock now,
    // and the window checked again, so the call advised is one that still fits.
    const fresh = nowSeconds();
    if (given.start === undefined) values.start = nextUsableStart(fresh);
    checkWindow(values.start, values.end, fresh);
    checkConflicts(existing, values, fresh, old.id);
  } catch (err) {
    return `${head} A new period from ${formatInstant(values.start, undefined)} to ${formatInstant(values.end, undefined)} would not pass the checks, so deleting this one to make room for it is not advised: ` +
      `${err instanceof Error ? err.message : String(err)} To stop the increase now, delete it with ads_delete_budget_schedule (dry_run: true first).`;
  }
  const lastStart = Math.floor((values.end - 3 * 3600) / 900) * 900;
  return [
    head,
    `To change it, in two steps, each confirmed with the person: (1) ads_delete_budget_schedule with budget_schedule_id ${id} and dry_run: true shows what it removes; called without dry_run it deletes the period and its increase stops at once.`,
    `(2) ${createCall(owner, values)} (${formatInstant(values.start, account.timezone)} to ${formatInstant(values.end, account.timezone)}). ` +
      `Its dry run passes only after the delete, since the two windows overlap. If that start is less than 2 minutes away by then, use the next quarter hour: the window needs at least 3 hours, so the last start that works is ${formatInstant(lastStart, undefined)}.`,
    "The new period, as checked now:",
    ...describeSchedule({ ...values, id: "(new)" }, { daily, currency: account.currency, timezone: account.timezone, now: nowSeconds() }),
    "Between the two steps no increase applies from this period. Meta can still refuse step 2, for example a window outside the campaign's schedule; then no increase applies until a new one is created.",
  ].join("\n");
}

const increaseText = (s: Values, currency: string | undefined) =>
  `+${s.type === "ABSOLUTE" ? formatMinorAmount(s.value, currency) : `${s.value}%`} (${s.type} ${s.value})`;

export function registerBudgetTools(server: McpServer): void {
  // ─── Create ──────────────────────────────────────────────────
  server.registerTool(
    "ads_create_budget_schedule",
    {
      description:
        `${WRITE_WARNING}Schedule a temporary budget INCREASE on a campaign or ad set with a daily budget (a "high demand period", e.g. Black Friday). ` +
        `${INCREASE_NOT_TOTAL} Run with dry_run: true first and confirm the total during the window with the person. ${RULES} ` +
        "daily_budget and budget_remaining never show the increase: read it with ads_get_budget_schedules. A lost answer is looked for before anything else is said; never create again before listing.",
      // Strict: the SDK drops a parameter it does not know, and a misspelt
      // dry_run would turn a preview into a write.
      inputSchema: z.strictObject({
        ...targetInput,
        budget_value: amountInput.describe(VALUE_NOTE),
        budget_value_type: z.enum(INCREASE_TYPES).describe(TYPE_NOTE),
        time_start: timeInput.describe(START_NOTE),
        time_end: timeInput.describe(END_NOTE),
        dry_run: z.boolean().optional().describe(DRY_RUN_NOTE),
      }),
      annotations: { ...CREATE },
    },
    async ({ campaign_id, ad_set_id, budget_value, budget_value_type, time_start, time_end, dry_run }) => {
      const { kind, id } = pickTarget(campaign_id, ad_set_id);
      const values: Values = {
        type: parseType(budget_value_type),
        value: parseIncrease(budget_value, "budget_value"),
        start: instantSeconds(time_start, "time_start"),
        end: instantSeconds(time_end, "time_end"),
      };
      const now = nowSeconds();
      checkWindow(values.start, values.end, now);

      const target = await readTarget(kind, id);
      const daily = requireDailyBudget(target);
      const account = await readAccount(target.accountId);
      checkIncrease(daily, values.type, values.value, account.currency);
      const existing = await listSchedulesForWrite(id);
      checkConflicts(existing, values, now);
      const context = { daily, currency: account.currency, timezone: account.timezone, now };
      const label = targetLabel(target);

      if (dry_run === true) {
        return text([
          `Dry run on the ${label}: nothing was created. The rules checked here pass; Meta can still refuse, for example a window outside the campaign's schedule.`,
          ...describeSchedule({ ...values, id: "(new)" }, context),
          "To create it, call again without dry_run.",
          NOT_IN_BUDGET_FIELDS,
        ]);
      }

      recheckWindow(values);
      const deadline = new Deadline();
      let created: { id: string; lost?: unknown };
      try {
        created = await createPeriod(id, values, existing, deadline);
      } catch (err) {
        if (wasRefused(err)) throw new McpError((err as McpError).code, `Nothing was created on the ${label}: Meta refused the new increase, or the request was not sent.${untrustedDetail(err)}`);
        if (!(err instanceof LostCreate)) throw err;
        throw new Error(`Meta did not confirm the new increase on the ${label}: it may or may not exist. List with ads_get_budget_schedules before trying again; a second create would add a second increase.${untrustedDetail(err.cause)}`);
      }
      const after = await readBack(created.id, deadline);
      return text([
        created.lost === undefined
          ? `Increase created on the ${label}.`
          : `Meta's answer was lost, but the period is there: increase created on the ${label}.${untrustedDetail(created.lost)}`,
        ...describeSchedule(after ?? { ...values, id: created.id }, { ...context, now: nowSeconds() }),
        readBackLine(after, values),
        NOT_IN_BUDGET_FIELDS,
      ]);
    },
  );

  // ─── List ────────────────────────────────────────────────────
  server.registerTool(
    "ads_get_budget_schedules",
    {
      description:
        "List the budget schedules (scheduled increases) of a campaign or ad set: for each period, the increase in money, the daily budget during its window, the window in the account's time zone and whether it is upcoming, IN PROGRESS or ended. " +
        "daily_budget and budget_remaining never show an increase, so this is how to tell whether one is running now.",
      inputSchema: z.strictObject({ ...targetInput }),
      annotations: { ...READ },
    },
    async ({ campaign_id, ad_set_id }) => {
      const { kind, id } = pickTarget(campaign_id, ad_set_id);
      const target = await readTarget(kind, id);
      const account = await readAccount(target.accountId);
      const { schedules, unreadable, repeating, complete } = await listSchedules(id);
      const now = nowSeconds();
      const { currency, timezone } = account;
      const label = targetLabel(target);
      const whole = complete && unreadable === 0 && repeating.length === 0;

      const budget = target.lifetime !== undefined
        ? `Lifetime budget: ${formatMinorAmount(target.lifetime, currency)}. Increases apply only to daily budgets.`
        : target.daily !== undefined
          ? `Daily budget: ${formatMinorAmount(target.daily, currency)}`
          : kind === "campaign"
            ? "No budget of its own: its budget is on its ad sets, so list each ad set."
            : `No budget of its own: its campaign${target.campaignId ? ` ${target.campaignId}` : ""} holds the budget, so list the campaign.`;
      const running = schedules.find((s) => scheduleStatus(s, now) === "in progress");
      const missing = [
        repeating.length > 0 && `${repeating.length} period${repeating.length === 1 ? " repeats" : "s repeat"}, which this tool does not read (listed below)`,
        unreadable > 0 && `${unreadable} period${unreadable === 1 ? "" : "s"} could not be read`,
        !complete && "Meta's list did not come back whole",
      ].filter(Boolean).join(", and ");
      const readAgain = !complete || unreadable > 0 ? " Read it again." : "";
      const context = { daily: target.daily, currency, timezone, now };

      const ownBudget = target.daily !== undefined || target.lifetime !== undefined;
      const elsewhere = kind === "campaign"
        ? "its budget is on its ad sets, so list each ad set"
        : `its campaign${target.campaignId ? ` ${target.campaignId}` : ""} holds the budget, so list the campaign`;

      return text([
        `Budget schedules of the ${label}`,
        budget,
        `Account currency ${currency ?? "not confirmed"}; time zone ${timezone ?? "not confirmed (times in UTC)"}`,
        running
          ? `Right now: an increase is IN PROGRESS (period ${running.id}, ${formatWindow(running.start, running.end, timezone)}).`
          : !ownBudget ? `Right now: not answered here: ${elsewhere}.`
            : whole ? "Right now: no increase in progress." : `Right now: not known: ${missing}.${readAgain}`,
        schedules.length === 0 && whole
          ? `No budget schedules on the ${label}.`
          : `${schedules.length} period${schedules.length === 1 ? "" : "s"} read${whole ? "" : ` (${missing})`}:`,
        ...schedules.flatMap((s) => describeSchedule(s, context)),
        ...repeating.map((r) => `Period ${r.id} repeats (recurrence_type ${r.recurrence}): its weekly schedule is not read or changed here; see it in Ads Manager.`),
        NOT_IN_BUDGET_FIELDS,
      ]);
    },
  );

  // ─── Update (replace) ────────────────────────────────────────
  server.registerTool(
    "ads_update_budget_schedule",
    {
      description:
        `${WRITE_WARNING}Change the increase or the window of a budget schedule that has not started yet. Meta retired editing a period in place (POST /{id}, measured 2026-11-15), so this REPLACES it: the period is deleted and a new one created with the new values, under a new id. ` +
        "Everything is checked first with the same rules as ads_create_budget_schedule. If Meta still refuses the new one, the tool tries to put the original back, and the answer says what is left. " +
        "Only a period that starts at least 8 minutes from now is replaced, so the original can still be put back. A period IN PROGRESS is not touched: a started period cannot be put back with its own start. The new period is checked first, and only if it passes does the answer give the two steps (delete it, then the exact create call from the next quarter hour); otherwise it says why, and not to delete it to make room. Other periods are not touched. " +
        `Changing budget_value_type needs budget_value too. Run with dry_run: true first. ${INCREASE_NOT_TOTAL}`,
      inputSchema: z.strictObject({
        budget_schedule_id: z.string().describe("ID of the budget schedule (period), as listed by ads_get_budget_schedules"),
        budget_value: amountInput.optional().describe(VALUE_NOTE),
        budget_value_type: z.enum(INCREASE_TYPES).optional().describe(`${TYPE_NOTE} Changing it needs budget_value too.`),
        time_start: timeInput.optional().describe(`${START_NOTE} For a replacement, at least 8 minutes from now.`),
        time_end: timeInput.optional().describe(END_NOTE),
        dry_run: z.boolean().optional().describe(DRY_RUN_NOTE),
      }),
      // A change deletes the period and creates another: if Meta refuses the
      // new one and the original cannot be put back, the increase is gone.
      annotations: { ...UPDATE, destructiveHint: true },
    },
    async ({ budget_schedule_id, budget_value, budget_value_type, time_start, time_end, dry_run }) => {
      const id = validateNumericId(budget_schedule_id, "budget_schedule_id");
      const given = {
        value: budget_value === undefined ? undefined : parseIncrease(budget_value, "budget_value"),
        type: budget_value_type === undefined ? undefined : parseType(budget_value_type),
        start: time_start === undefined ? undefined : instantSeconds(time_start, "time_start"),
        end: time_end === undefined ? undefined : instantSeconds(time_end, "time_end"),
      };
      if (Object.values(given).every((v) => v === undefined)) {
        throw new Error("Nothing to change: give budget_value, budget_value_type, time_start or time_end.");
      }

      const old = await readSchedule(id);
      const objectId = old.objectId as string;
      const now = nowSeconds();
      const status = scheduleStatus(old, now);
      if (status === "ended") {
        throw new Error(`Budget schedule ${id} has ended, so there is nothing to change. Create a new one with ads_create_budget_schedule.`);
      }
      if (given.type !== undefined && given.type !== old.type && given.value === undefined) {
        throw new Error("Changing budget_value_type changes what budget_value means (with ABSOLUTE it is an amount in the account currency's minor unit, with MULTIPLIER a percentage of the daily budget, so the same 500 is a small amount in one and +500% in the other): give budget_value too.");
      }
      const changes = (Object.keys(given) as Array<keyof Values>).some((key) => given[key] !== undefined && given[key] !== old[key]);
      if (!changes) throw new Error(`Nothing to change: budget schedule ${id} already has these values.`);
      if (status === "in progress") throw new Error(await inProgressAdvice(id, old, given, now));
      if (old.start < now + REPLACE_LEAD) {
        throw new Error(`Budget schedule ${id} starts in less than 8 minutes, so it is not replaced: if Meta refused the new one, the original might not be put back in time. Once it starts, the answer here gives the steps to change it; or delete it with ads_delete_budget_schedule.`);
      }

      const values: Values = {
        value: given.value ?? old.value,
        type: given.type ?? old.type,
        start: given.start ?? old.start,
        end: given.end ?? old.end,
      };
      if (values.start < now + REPLACE_LEAD) {
        throw new Error(`time_start must be at least 8 minutes from now for a replacement, so the original can still be put back if Meta refuses the new one; ${formatInstant(values.start, undefined)} is closer.`);
      }
      checkWindow(values.start, values.end, now);

      const target = await readOwner(objectId);
      const daily = requireDailyBudget(target);
      const account = await readAccount(target.accountId);
      checkIncrease(daily, values.type, values.value, account.currency);
      const existing = await listSchedulesForWrite(objectId);
      checkConflicts(existing, values, now, old.id);
      const context = { daily, currency: account.currency, timezone: account.timezone, now };
      const label = targetLabel(target);
      const before = describeSchedule(old, context);
      const how = "Meta no longer edits a period in place, so the period is deleted and a new one created, with a new id. Other periods are not touched.";

      if (dry_run === true) {
        return text([
          `Dry run on the ${label}: nothing was changed. The rules checked here pass; Meta can still refuse the new period, for example a window outside the campaign's schedule, and then the tool tries to put the original back.`,
          how,
          "Before:",
          ...before,
          "After:",
          ...describeSchedule({ ...values, id: "(new)" }, context),
          "To apply it, call again without dry_run.",
          NOT_IN_BUDGET_FIELDS,
        ]);
      }

      // Slow reads must not carry a stale clock into the delete: both starts
      // are checked again, just before it.
      const fresh = nowSeconds();
      if (old.start < fresh + REPLACE_LEAD || values.start < fresh + REPLACE_LEAD) {
        throw new Error(`Nothing was changed: by the time the checks were done, the period or its new start was less than 8 minutes away. Run it again with a later start, or delete the period.`);
      }
      recheckWindow(values);
      const deadline = new Deadline();
      await deletePeriod(id, (cause) => new Error(
        `Meta did not confirm deleting budget schedule ${id}: it may or may not have been deleted, and nothing new was created. Check with ads_get_budget_schedules before trying again.${untrustedDetail(cause)}`,
      ), `Nothing was changed: Meta refused deleting budget schedule ${id}, or the request was not sent.`, deadline);
      const original = `${increaseText(old, account.currency)}, ${formatWindow(old.start, old.end, account.timezone)}`;
      // Never a "new" period, even when the list before the delete did not
      // show it: a stale read afterwards can.
      const known = [...existing, old];

      let created: { id: string; lost?: unknown };
      try {
        created = await createPeriod(objectId, values, known, deadline);
      } catch (err) {
        if (err instanceof OutOfTime) {
          throw new Error(`Budget schedule ${id} was deleted, but ${err.message}, so nothing new was created. To make the new one, call ${createCall(target, values)}, with dry_run first. The original was ${original}.`);
        }
        if (err instanceof LostCreate) {
          throw new Error(`Budget schedule ${id} was deleted, but Meta did not confirm its replacement: it may or may not exist. List with ads_get_budget_schedules before trying again; a second create would add a second increase. The original was ${original}.${untrustedDetail(err.cause)}`);
        }
        // Meta refused the replacement, or it was not sent. The original can
        // come back only with the start it had, while that start is ahead.
        if (!canStillStart(old.start, nowSeconds())) {
          throw new Error(
            `The replacement was refused or not sent. The original period ${id} was about to start and has been deleted; it cannot be put back, since Meta does not accept a start in the past. ` +
            `That increase is gone; other periods are not touched. The original was ${original}.${untrustedDetail(err)}`,
          );
        }
        const noTime = () => new Error(
          `The replacement was refused or not sent, and the original period ${id} is deleted and was not put back: there was not enough time left in this answer to check the periods and put it back safely. ` +
          `To recreate it, list with ads_get_budget_schedules first, then call ${createCall(target, old)} while its start is at least 2 minutes away. The original was ${original}. Other periods are not touched.${untrustedDetail(err)}`,
        );
        if (!deadline.hasRoomFor(2)) throw noTime();
        // Another writer may have added a period since the list was read (a
        // second call on the same period, say): putting the original back
        // next to it could add two increases, so a period not seen before
        // stops the restore.
        let seen: Awaited<ReturnType<typeof listSchedules>> | undefined;
        try {
          seen = await listSchedules(objectId, () => deadline.scope());
        } catch {
          seen = undefined;
        }
        const knownIds = new Set(known.map((k) => k.id));
        const stranger = seen?.schedules.find((p) => !knownIds.has(p.id));
        if (!seen || !seen.complete || seen.unreadable > 0 || seen.repeating.length > 0 || stranger) {
          throw new Error(
            `The replacement was refused or not sent, and the original period ${id} is deleted and was not put back: ` +
            (stranger ? `period ${stranger.id}, which was not there before, has appeared, and the two could add up.` : "the periods could not be read whole, so putting it back could add a second increase.") +
            ` List with ads_get_budget_schedules before recreating it. The original was ${original}. Other periods are not touched.${untrustedDetail(err)}`,
          );
        }
        // The list took time: the original's start is checked again.
        if (!canStillStart(old.start, nowSeconds())) {
          throw new Error(
            `The replacement was refused or not sent. The original period ${id} was about to start and has been deleted; it cannot be put back, since Meta does not accept a start in the past. ` +
            `That increase is gone; other periods are not touched. The original was ${original}.${untrustedDetail(err)}`,
          );
        }
        let restored: string;
        try {
          restored = (await createPeriod(objectId, old, known, deadline)).id;
        } catch (restoreErr) {
          if (restoreErr instanceof OutOfTime) throw noTime();
          const lostRestore = restoreErr instanceof LostCreate;
          throw new Error(
            `The replacement was refused or not sent, and the original period ${id} ${lostRestore
              ? "may or may not have been put back: Meta's answer was lost. List with ads_get_budget_schedules to see whether it is there"
              : "is deleted and could not be put back"}. ` +
            `The original was ${original}. Other periods are not touched.` +
            `${untrustedDetail(err)}${untrustedDetail(lostRestore ? restoreErr.cause : restoreErr)}`,
          );
        }
        throw new Error(`The replacement was refused or not sent, so the original period was put back as ${restored}, with its values: ${original}. Nothing else changed.${untrustedDetail(err)}`);
      }

      const after = await readBack(created.id, deadline);
      return text([
        `Budget schedule ${id} replaced on the ${label}. ${how}`,
        created.lost !== undefined && `Meta's answer was lost when creating the new period, but the new period is there.${untrustedDetail(created.lost)}`,
        "Before:",
        ...before,
        "After:",
        ...describeSchedule(after ?? { ...values, id: created.id }, { ...context, now: nowSeconds() }),
        readBackLine(after, values),
        NOT_IN_BUDGET_FIELDS,
      ]);
    },
  );

  // ─── Delete ──────────────────────────────────────────────────
  server.registerTool(
    "ads_delete_budget_schedule",
    {
      description:
        `${WRITE_WARNING}Delete a budget schedule (a scheduled increase). Cannot be undone. An upcoming period never starts; on one IN PROGRESS the increase stops at once. Other periods are not touched. ` +
        "Run with dry_run: true first: it shows what would be removed and deletes nothing.",
      inputSchema: z.strictObject({
        budget_schedule_id: z.string().describe("ID of the budget schedule (period), as listed by ads_get_budget_schedules"),
        dry_run: z.boolean().optional().describe("true = read the period and show what deleting it would remove and what that changes, without deleting it."),
      }),
      annotations: { ...DELETE },
    },
    async ({ budget_schedule_id, dry_run }) => {
      const id = validateNumericId(budget_schedule_id, "budget_schedule_id");
      const old = await readSchedule(id);
      let target: BudgetTarget = { kind: "object", id: old.objectId as string };
      try {
        target = await readTarget("object", target.id);
      } catch {
        // Only words the result.
      }
      const account = await readAccount(target.accountId);
      const described = describeSchedule(old, { daily: target.daily, currency: account.currency, timezone: account.timezone, now: nowSeconds() });

      if (dry_run === true) {
        const status = scheduleStatus(old, nowSeconds());
        const would = status === "in progress" ? "It is in progress: its increase would stop at once."
          : status === "upcoming" ? "It would not start." : "It has ended, so deleting it changes nothing for delivery.";
        return text([`Dry run on the ${targetLabel(target)}: nothing was deleted. Deleting budget schedule ${id} would remove:`, ...described, would, "Other periods would not be touched. To delete it, call again without dry_run."]);
      }

      await deletePeriod(id, (cause) => new Error(
        `Meta did not confirm deleting budget schedule ${id}: it may or may not be deleted. Check with ads_get_budget_schedules.${untrustedDetail(cause)}`,
      ), `Nothing was deleted: Meta refused deleting budget schedule ${id}, or the request was not sent.`, new Deadline());

      const status = scheduleStatus(old, nowSeconds());
      const effect = status === "in progress" ? "It was in progress: its increase stops now."
        : status === "upcoming" ? "It will not start." : "It had already ended, so delivery does not change.";
      return text([`Deleted budget schedule ${id} from the ${targetLabel(target)}. What was deleted, as it stood just before:`, ...described, effect, "Other periods are not touched."]);
    },
  );
}
