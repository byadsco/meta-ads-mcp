// Budget schedules ("high demand periods"): a temporary increase ADDED to the
// daily budget of a campaign or an ad set. The rules below were measured on
// Graph API v26.0 on 2026-11-15, in a USD account with a daily budget of
// 1000, with Meta's error subcode next to each; the limit of 50 periods comes
// from Meta's documentation and the 2-minute lead is this server's own.
import { metaApiClient } from "./client.js";
import { wasRefused } from "./errors.js";
import { scrubbed } from "./read-list.js";
import { formatMinorAmount } from "./currency.js";
import { instantSeconds } from "../utils/time.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

export type IncreaseType = "ABSOLUTE" | "MULTIPLIER";
export const INCREASE_TYPES = ["ABSOLUTE", "MULTIPLIER"] as const;

export interface Schedule {
  id: string;
  objectId?: string;
  value: number;
  type: IncreaseType;
  start: number;
  end: number;
}

export const SCHEDULE_FIELDS = "id,ad_object_id,budget_value,budget_value_type,recurrence_type,time_start,time_end";

const QUARTER_HOUR = 900;
const MIN_WINDOW = 3 * 3600; // 3858094
// Not Meta's: the time a request can take to arrive. Meta refuses a start it
// already sees as past (3858085) and accepted one 6 minutes ahead.
const MIN_LEAD = 120;
// 8000 on a daily budget of 1000 was accepted and 8001 refused (3858092,
// "enter US$80.00 or less"), and MULTIPLIER 800 accepted and 801 refused with
// the same message: the INCREASE is at most 8 × the daily budget.
const MAX_TIMES_DAILY = 8;
const MAX_PERCENT = 100 * MAX_TIMES_DAILY;
const MAX_PER_OBJECT = 50; // Meta's documentation
const MAX_DIGITS = 15;

const utc = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");

// The form Meta sends (measured): "2026-11-16T15:00:00+0000". Anything else is
// not guessed at: a time without an offset would be read in the server's zone,
// and a day or hour that does not exist is refused, not rolled over.
const META_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/;

function metaInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !META_INSTANT.test(value)) return undefined;
  try {
    return instantSeconds(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"), "time");
  } catch {
    return undefined;
  }
}

/** A recurrence as Meta names it, or "not shown" for anything that is not plain capitals: it is Meta's text, shown unfenced. */
const recurrenceText = (value: string): string => (/^[A-Z_]{1,20}$/.test(value) ? value : "not shown");

/** A period as Meta returns it, or undefined when any part of it cannot be read. */
export function parseSchedule(raw: unknown): Schedule | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const value = typeof r.budget_value === "string" && /^\d{1,15}$/.test(r.budget_value) ? Number(r.budget_value) : r.budget_value;
  const start = metaInstant(r.time_start);
  const end = metaInstant(r.time_end);
  if (typeof r.id !== "string" || !/^\d{1,30}$/.test(r.id)) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  if (r.budget_value_type !== "ABSOLUTE" && r.budget_value_type !== "MULTIPLIER") return undefined;
  // A period that repeats has a weekly schedule these tools neither show nor
  // keep: read as one-time, a replacement would drop its recurrence.
  if (r.recurrence_type !== "ONE_TIME") return undefined;
  if (start === undefined || end === undefined) return undefined;
  const objectId = typeof r.ad_object_id === "string" && /^\d{1,30}$/.test(r.ad_object_id) ? r.ad_object_id : undefined;
  return { id: r.id, ...(objectId ? { objectId } : {}), value, type: r.budget_value_type, start, end };
}

/** A positive whole number, given as a number or as its digits. */
export function parseIncrease(value: unknown, name: string): number {
  const n = typeof value === "string" && new RegExp(`^\\d{1,${MAX_DIGITS}}$`).test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive whole number (digits only, no separators). Got: ${JSON.stringify(value)?.slice(0, 40)}`);
  }
  return n;
}

/** The first quarter hour a new period can start at, leaving time for the request to arrive. */
export function nextUsableStart(now: number): number {
  return Math.ceil((now + MIN_LEAD) / QUARTER_HOUR) * QUARTER_HOUR;
}

/** Whether a period starting then can still be sent now. */
export function canStillStart(start: number, now: number): boolean {
  return start >= now + MIN_LEAD;
}

export function checkWindow(start: number, end: number, now: number): void {
  if (end <= start) throw new Error(`time_end must be after time_start (window ${utc(start)} → ${utc(end)} UTC).`);
  if (start % QUARTER_HOUR !== 0 || end % QUARTER_HOUR !== 0) {
    throw new Error(`Meta only takes times on a quarter hour (:00, :15, :30, :45); got ${utc(start)} → ${utc(end)} UTC.`);
  }
  if (end - start < MIN_WINDOW) {
    throw new Error(`Meta needs a window of at least 3 hours; ${utc(start)} → ${utc(end)} UTC is ${Math.round((end - start) / 60)} minutes.`);
  }
  if (!canStillStart(start, now)) {
    throw new Error(`time_start must be in the future, at least 2 minutes from now: ${utc(start)} UTC has passed or is too close. The next start you can use is ${utc(nextUsableStart(now))} UTC.`);
  }
}

/** What the increase adds, in the daily budget's unit; for MULTIPLIER an estimate on today's daily budget. */
export function increaseAmount(daily: number, type: IncreaseType, value: number): number {
  return type === "ABSOLUTE" ? value : Math.floor((daily * value) / 100);
}

export function checkIncrease(daily: number, type: IncreaseType, value: number, currency: string | undefined): void {
  if (type === "MULTIPLIER" && value > MAX_PERCENT) {
    throw new Error(`Meta caps the increase at 8 × the daily budget: a MULTIPLIER (percentage) of at most ${MAX_PERCENT}; got ${value}.`);
  }
  const cap = daily * MAX_TIMES_DAILY;
  if (type === "ABSOLUTE" && value > cap) {
    throw new Error(`Meta caps the increase at 8 × the daily budget: at most ${formatMinorAmount(cap, currency)} (${cap}) on a daily budget of ${formatMinorAmount(daily, currency)}; got ${formatMinorAmount(value, currency)} (${value}). budget_value is the increase, not the total.`);
  }
}

export function scheduleStatus(s: Pick<Schedule, "start" | "end">, now: number): "upcoming" | "in progress" | "ended" {
  if (now < s.start) return "upcoming";
  return now < s.end ? "in progress" : "ended";
}

/**
 * Refuses what Meta refuses about a new period next to the others on the same
 * campaign or ad set: an overlap (3858167), mixing ABSOLUTE with MULTIPLIER
 * (3858093) and a 51st period. An ended period counts for the mix rule too:
 * whether Meta counts it is not known, and a replacement that Meta then
 * refuses would have deleted a period in progress for nothing.
 */
export function checkConflicts(
  existing: readonly Schedule[],
  candidate: { start: number; end: number; type: IncreaseType },
  now: number,
  excludeId?: string,
): void {
  const others = existing.filter((s) => s.id !== excludeId);
  const overlap = others.find((s) => s.start < candidate.end && candidate.start < s.end);
  if (overlap) {
    throw new Error(`The window overlaps period ${overlap.id} (${utc(overlap.start)} → ${utc(overlap.end)} UTC) on the same campaign or ad set, and Meta does not allow overlapping periods. Change the window, or change or delete that period.`);
  }
  const otherKind = others.find((s) => s.type !== candidate.type);
  if (otherKind) {
    const ended = scheduleStatus(otherKind, now) === "ended" ? " (ended)" : "";
    throw new Error(`Period ${otherKind.id}${ended} on the same campaign or ad set is ${otherKind.type}, and Meta does not mix ABSOLUTE (an amount) with MULTIPLIER (a percentage) on one campaign or ad set. Use ${otherKind.type}, or delete the ${otherKind.type} periods first.`);
  }
  if (others.length >= MAX_PER_OBJECT) {
    throw new Error(`Meta allows at most ${MAX_PER_OBJECT} periods per campaign or ad set, and this one has ${others.length}. Delete one first.`);
  }
}

function localParts(seconds: number, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(seconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

function span(start: number, end: number, zone: string, label: string): string {
  const a = localParts(start, zone);
  const b = localParts(end, zone);
  return `${a.day} ${a.time} → ${a.day === b.day ? b.time : `${b.day} ${b.time}`} ${label}`;
}

/** The window in the account's time zone and in UTC, or in UTC alone when the zone is unknown or not a real one. */
export function formatWindow(start: number, end: number, timezone: string | undefined): string {
  const inUtc = span(start, end, "UTC", "UTC");
  if (!timezone) return inUtc;
  try {
    return `${span(start, end, timezone, timezone)} (${inUtc})`;
  } catch {
    return inUtc;
  }
}

/** One instant in the account's time zone and in UTC, or in UTC alone. */
export function formatInstant(seconds: number, timezone: string | undefined): string {
  const inUtc = `${utc(seconds)} UTC`;
  if (!timezone) return inUtc;
  try {
    const local = localParts(seconds, timezone);
    return `${local.day} ${local.time} ${timezone} (${inUtc})`;
  } catch {
    return inUtc;
  }
}

function untilText(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return [days ? `${days} d` : "", hours ? `${hours} h` : "", `${minutes % 60} min`].filter(Boolean).join(" ");
}

export interface DescribeContext {
  daily?: number;
  currency?: string;
  timezone?: string;
  now: number;
}

/** The lines that describe one period: its state, the increase, the daily budget during the window and the window. */
export function describeSchedule(s: Schedule, context: DescribeContext): string[] {
  const { daily, currency, timezone, now } = context;
  const status = scheduleStatus(s, now);
  const state = status === "upcoming" ? `upcoming, starts in ${untilText(s.start - now)}`
    : status === "in progress" ? `IN PROGRESS, ends in ${untilText(s.end - now)}` : "ended";
  const lines = [`Period ${s.id}: ${state}`];
  if (s.type === "ABSOLUTE") {
    lines.push(`  Increase: +${formatMinorAmount(s.value, currency)} on top of the daily budget (ABSOLUTE ${s.value})`);
  } else {
    const about = daily !== undefined ? `, about +${formatMinorAmount(increaseAmount(daily, s.type, s.value), currency)} on today's daily budget` : "";
    lines.push(`  Increase: +${s.value}% of the daily budget (MULTIPLIER ${s.value})${about}`);
  }
  if (daily !== undefined) {
    const total = daily + increaseAmount(daily, s.type, s.value);
    const basis = status === "ended" ? ", on today's daily budget, which may have differed then" : "";
    lines.push(`  Daily budget during the window: ${s.type === "MULTIPLIER" ? "about " : ""}${formatMinorAmount(total, currency)} (daily budget ${formatMinorAmount(daily, currency)} + the increase${basis})`);
  }
  lines.push(`  Window: ${formatWindow(s.start, s.end, timezone)}`);
  return lines;
}

export const NOT_IN_BUDGET_FIELDS =
  "daily_budget and budget_remaining never include a scheduled increase: Meta reports them unchanged during the window. ads_get_budget_schedules shows the increases.";

export type TargetKind = "campaign" | "ad_set" | "object";

export interface BudgetTarget {
  kind: TargetKind;
  id: string;
  daily?: number;
  lifetime?: number;
  accountId?: string;
  campaignId?: string;
}

const KIND_FIELDS: Record<TargetKind, string> = {
  // A campaign has no campaign_id and an ad set no objective (measured): asking
  // for one of them makes Meta refuse an id of the other kind.
  campaign: "daily_budget,lifetime_budget,account_id,objective",
  ad_set: "daily_budget,lifetime_budget,account_id,campaign_id",
  object: "daily_budget,lifetime_budget,account_id",
};

export const KIND_LABEL: Record<TargetKind, string> = { campaign: "campaign", ad_set: "ad set", object: "campaign or ad set" };

const amount = (raw: unknown): number | undefined => {
  const n = typeof raw === "string" && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

const saidOf = (err: unknown): string =>
  (typeof (err as { said?: unknown })?.said === "string" ? (err as { said: string }).said : undefined)
  ?? (singleLine(err instanceof Error ? err.message : String(err), 300) || "(no detail)");

/**
 * What Meta or the transport said about a failure, inside the untrusted
 * fence: Meta's error text can quote what others wrote, and it is data for
 * the agent, never instructions. Starts with a line break.
 */
export function untrustedDetail(err: unknown): string {
  return `\nDetail from Meta or the network:\n${ADVERTISER_CONTENT_OPEN}\n${saidOf(err)}\n${ADVERTISER_CONTENT_CLOSE}`;
}

/** A failed call to Meta, its own words kept apart (`said`) and shown only inside the fence. */
class FencedMcpError extends McpError {
  constructor(code: number, readonly said: string, data: unknown) {
    super(code, `The request to Meta failed.${untrustedDetail({ said })}`, data);
  }
}

class FencedError extends Error {
  constructor(readonly said: string) {
    super(`The request to Meta failed.${untrustedDetail({ said })}`);
  }
}

/**
 * Every call to Meta here goes through this: a failure comes back with Meta's
 * or the transport's text inside the untrusted fence, and an McpError keeps
 * its code, so a refusal still reads as one (wasRefused).
 */
export async function fromMeta<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const said = saidOf(err);
    throw err instanceof McpError ? new FencedMcpError(err.code, said, err.data) : new FencedError(said);
  }
}

/** The budget of a campaign or ad set, refusing an id of the other kind. */
/** An id read as a campaign that is not one, or as an ad set that is not one. */
class WrongKind extends Error {}

export async function readTarget(kind: TargetKind, id: string): Promise<BudgetTarget> {
  let raw: Record<string, unknown>;
  try {
    raw = scrubbed(await fromMeta(() => metaApiClient.get<Record<string, unknown>>(`/${id}`, { fields: KIND_FIELDS[kind] })));
  } catch (err) {
    if (!wasRefused(err) || kind === "object") throw err;
    const other = kind === "campaign" ? "ad_set_id" : "campaign_id";
    throw new WrongKind(`${kind === "campaign" ? "campaign_id" : "ad_set_id"} ${id} could not be read as ${kind === "campaign" ? "a campaign" : "an ad set"}. If it is ${kind === "campaign" ? "an ad set" : "a campaign"}, pass it as ${other}.${untrustedDetail(err)}`);
  }
  const accountId = typeof raw.account_id === "string" && /^\d{1,30}$/.test(raw.account_id) ? raw.account_id : undefined;
  const campaignId = typeof raw.campaign_id === "string" && /^\d{1,30}$/.test(raw.campaign_id) ? raw.campaign_id : undefined;
  return { kind, id, daily: amount(raw.daily_budget), lifetime: amount(raw.lifetime_budget), accountId, campaignId };
}

/** The budget of the object a period belongs to, and whether it is a campaign or an ad set: a create needs to name which. */
export async function readOwner(id: string): Promise<BudgetTarget> {
  try {
    return await readTarget("campaign", id);
  } catch (err) {
    if (!(err instanceof WrongKind)) throw err;
  }
  return readTarget("ad_set", id);
}

/**
 * The daily budget an increase can be scheduled on, or an error that says
 * where the budget is. Meta refuses a lifetime budget, a campaign whose budget
 * is on its ad sets and an ad set under a campaign budget alike (3858199).
 */
export function requireDailyBudget(target: BudgetTarget): number {
  const label = `${KIND_LABEL[target.kind]} ${target.id}`;
  if (target.lifetime !== undefined) {
    throw new Error(`The ${label} has a lifetime budget. Meta schedules increases only on daily budgets.`);
  }
  if (target.daily !== undefined) return target.daily;
  if (target.kind === "campaign") {
    throw new Error(`The ${label} has no budget of its own: its budget is on its ad sets. Schedule the increase on each ad set with ad_set_id.`);
  }
  if (target.kind === "ad_set") {
    throw new Error(`The ${label} has no budget of its own: its campaign${target.campaignId ? ` ${target.campaignId}` : ""} holds the budget (Advantage+ campaign budget). Schedule the increase on the campaign with campaign_id.`);
  }
  throw new Error(`The ${label} has no daily budget, so an increase cannot apply to it.`);
}

export interface Listed {
  schedules: Schedule[];
  unreadable: number;
  /** Periods that repeat (recurrence_type other than ONE_TIME): not shown or changed here. */
  repeating: Array<{ id: string; recurrence: string }>;
  /** Every page Meta has was read. False when a page had no list, a page was missing its cursor or repeated one, or there were more pages than are read. */
  complete: boolean;
}

// Meta keeps at most 50 periods per campaign or ad set: five pages of 100
// are far more than enough, and a list that does not end there is not trusted.
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

type Page = { data?: unknown; paging?: { next?: unknown; cursors?: { after?: unknown } } };

/** How one call to Meta is sent; undefined means it no longer fits its deadline and is not sent. */
export type CallScope = Parameters<typeof metaApiClient.get>[2];

/**
 * Every period on a campaign or ad set, oldest start first, and whether the
 * list is known to be whole. With `scopeFor`, each page is sent with the scope
 * it gives, and a page it has no time for is not sent: the list is then not
 * whole.
 */
export async function listSchedules(objectId: string, scopeFor?: () => CallScope | undefined): Promise<Listed> {
  const path = `/${objectId}/budget_schedules`;
  const params = { fields: SCHEDULE_FIELDS, limit: PAGE_SIZE };
  const raw: unknown[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const scope = scopeFor?.();
    if (scopeFor && !scope) break;
    const answer = await fromMeta(() => metaApiClient.get<Page>(path, after === undefined ? params : { ...params, after }, scope));
    // An answer without a list is not "no periods": a write would skip its checks.
    if (!Array.isArray(answer?.data)) {
      if (page === 0) throw new Error(`Meta's list of periods on ${objectId} could not be read.`);
      break;
    }
    raw.push(...answer.data);
    if (!answer.paging?.next) {
      complete = true;
      break;
    }
    const cursor = answer.paging.cursors?.after;
    if (typeof cursor !== "string" || cursor === "" || seen.has(cursor)) break;
    seen.add(cursor);
    after = cursor;
  }
  const schedules: Schedule[] = [];
  const repeating: Listed["repeating"] = [];
  let unreadable = 0;
  for (const item of scrubbed(raw)) {
    const s = parseSchedule(item);
    const r = item as { id?: unknown; recurrence_type?: unknown } | null;
    if (s) schedules.push(s);
    else if (typeof r?.id === "string" && /^\d{1,30}$/.test(r.id) && typeof r.recurrence_type === "string" && r.recurrence_type !== "ONE_TIME") {
      repeating.push({ id: r.id, recurrence: recurrenceText(r.recurrence_type) });
    } else unreadable += 1;
  }
  schedules.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return { schedules, unreadable, repeating, complete };
}

/** For a write, which has to see every period: one missing or unreadable could hide an overlap. */
export async function listSchedulesForWrite(objectId: string): Promise<Schedule[]> {
  const { schedules, unreadable, repeating, complete } = await listSchedules(objectId);
  if (repeating.length > 0) {
    throw new Error(`Period ${repeating[0].id} repeats (recurrence_type ${repeating[0].recurrence}) on ${objectId}, and these tools neither show nor keep a weekly schedule, so they change nothing on this campaign or ad set. Nothing was changed; use Ads Manager.`);
  }
  if (!complete) {
    throw new Error(`Meta's list of periods on ${objectId} did not come back whole, so an overlap could not be ruled out. Nothing was changed; try again.`);
  }
  if (unreadable > 0) {
    throw new Error(`${unreadable} of the periods on ${objectId} could not be read, so an overlap could not be ruled out. Nothing was changed; ads_get_budget_schedules lists them.`);
  }
  return schedules;
}

export async function readSchedule(id: string): Promise<Schedule> {
  let raw: unknown;
  try {
    raw = scrubbed(await fromMeta(() => metaApiClient.get<unknown>(`/${id}`, { fields: SCHEDULE_FIELDS })));
  } catch (err) {
    if (!wasRefused(err)) throw err;
    throw new Error(`Budget schedule ${id} could not be read: it does not exist (it may have been deleted), or it is not a budget schedule this token can see.${untrustedDetail(err)}`);
  }
  const recurrence = (raw as { recurrence_type?: unknown } | null)?.recurrence_type;
  if (typeof recurrence === "string" && recurrence !== "ONE_TIME") {
    throw new Error(`Budget schedule ${id} repeats (recurrence_type ${recurrenceText(recurrence)}), which these tools do not handle. Change or delete it in Ads Manager.`);
  }
  const s = parseSchedule(raw);
  if (!s || !s.objectId) throw new Error(`Meta's answer for budget schedule ${id} could not be read whole.`);
  return s;
}

export interface AccountInfo {
  currency?: string;
  timezone?: string;
}

/** The account's currency and time zone, only to word a result: a failed read leaves them unknown. */
export async function readAccount(accountId: string | undefined): Promise<AccountInfo> {
  if (!accountId) return {};
  try {
    const raw = await metaApiClient.get<Record<string, unknown>>(`/act_${accountId}`, { fields: "currency,timezone_name" });
    const currency = typeof raw.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency) ? raw.currency.toUpperCase() : undefined;
    const timezone = typeof raw.timezone_name === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(raw.timezone_name) ? raw.timezone_name : undefined;
    return { currency, timezone };
  } catch {
    return {};
  }
}

export const sameValues = (a: Omit<Schedule, "id" | "objectId">, b: Omit<Schedule, "id" | "objectId">): boolean =>
  a.value === b.value && a.type === b.type && a.start === b.start && a.end === b.end;
