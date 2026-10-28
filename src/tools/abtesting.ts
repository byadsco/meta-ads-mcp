import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { wasRefused } from "../meta/errors.js";
import { readList, scrubbed } from "../meta/read-list.js";
import { STUDY_DEFAULT_FIELDS } from "../meta/types/study.js";
import type { AdStudy, AdStudyCell } from "../meta/types/index.js";
import { normalizeAccountId, validateNumericId } from "../utils/format.js";
import { ADVERTISER_CONTENT_CLOSE, ADVERTISER_CONTENT_OPEN, singleLine } from "../utils/single-line.js";
import { metaTimeSeconds, unixSeconds } from "../utils/time.js";
import { READ, CREATE, DELETE, WRITE_WARNING } from "./_register.js";

// Measured on v26.0 against a test account:
// - studies are created on a Business Manager (POST /{business_id}/ad_studies);
//   POST /act_{id}/ad_studies is "Unsupported post request";
// - times are Unix seconds ("Param end_time must be a number" for ISO text);
// - a lift study needs cooldown_start_time and observation_end_time;
// - execution_options validate_only is ignored: the study is created;
// - neither the account's nor the Business Manager's ad_studies list showed a
//   study made through the API; the campaigns and ad sets in its cells do;
// - a study that has not started can be deleted (DELETE /{study_id}).
const FIELDS = STUDY_DEFAULT_FIELDS.join(",");
const CELL_FIELDS = "cells{id,name,treatment_percentage,control_percentage,adsets{id},campaigns{id}}";
const OBJECTIVE_FIELDS = "objectives{id,name,type,is_primary}";
const NESTED_LIMIT = 25;
// Entities whose studies run past the expansion, read one by one.
const MAX_FOLLOWED = 20;
// Meta's documented limits for a study.
const MAX_CELLS = 150;
const MAX_PER_CELL = 100;
// Each entity costs two reads in the eligibility check.
const MAX_CHECKED = 30;

const STUDY_TYPES = ["SPLIT_TEST", "LIFT"] as const;
const LISTED_TYPES = [
  "SPLIT_TEST", "SPLIT_TEST_V2", "LIFT", "CONTINUOUS_LIFT_CONFIG", "GEO_LIFT", "BACKEND_AB_TESTING",
  "CREATIVE_SPEND_ENFORCEMENT", "PORTFOLIO_OPTIMIZER", "VERSION_CONTROL",
] as const;
const OBJECTIVE_TYPES = ["CONVERSIONS", "SALES", "NONSALES", "MAE", "TELCO", "FTL", "MAI", "PARTNER", "BRANDLIFT", "BRAND", "MPC_CONVERSION"] as const;

const timeInput = (what: string) =>
  z.string().describe(`${what}: a day (2026-11-04, UTC) or a time with its offset (2026-11-04T09:00:00-05:00). Sent to Meta as Unix seconds.`);

const cellInput = z.object({
  name: z.string().min(1).max(100).describe("Cell name"),
  treatment_percentage: z.number().gt(0).max(100).describe("Share of the audience in this cell (%)"),
  control_percentage: z.number().gt(0).max(100).optional().describe("Lift studies only: the share held back as the control group (%)"),
  ad_sets: z.array(z.string()).min(1).max(MAX_PER_CELL).optional().describe("Ad set IDs in this cell. Give ad_sets or campaigns."),
  campaigns: z.array(z.string()).min(1).max(MAX_PER_CELL).optional().describe("Campaign IDs in this cell. Give ad_sets or campaigns."),
});
type CellInput = z.infer<typeof cellInput>;
type StudyType = (typeof STUDY_TYPES)[number];
type Kind = "ad set" | "campaign";

interface PlannedCell {
  name: string;
  treatment_percentage: number;
  control_percentage?: number;
  adsets?: string[];
  campaigns?: string[];
}

/**
 * The cells as Meta takes them, and every problem with their shape that
 * Meta documents or was measured refusing. Problems are returned, not
 * thrown, so the eligibility check can list them all.
 */
function planCells(type: StudyType, cells: CellInput[]): { cells: PlannedCell[]; entities: Array<{ id: string; kind: Kind }>; problems: string[] } {
  const problems: string[] = [];
  if (type === "SPLIT_TEST" && cells.length < 2) problems.push("An A/B test needs at least two cells to compare.");
  if (cells.length > MAX_CELLS) problems.push(`Meta takes at most ${MAX_CELLS} cells in a study.`);
  const seen = new Set<string>();
  const entities: Array<{ id: string; kind: Kind }> = [];
  const planned = cells.map((cell, i) => {
    const label = `cell ${i + 1}`;
    if (Boolean(cell.ad_sets?.length) === Boolean(cell.campaigns?.length)) problems.push(`${label} needs ad_sets or campaigns, one of the two.`);
    if (type === "SPLIT_TEST" && cell.control_percentage !== undefined) {
      problems.push(`${label}: control_percentage is for lift studies; an A/B test compares its cells with each other.`);
    }
    if (type === "LIFT" && cell.control_percentage === undefined) {
      problems.push(`${label}: a lift study needs control_percentage, the share held back to measure against.`);
    }
    const kind: Kind = cell.ad_sets?.length ? "ad set" : "campaign";
    const ids: string[] = [];
    for (const id of (kind === "ad set" ? cell.ad_sets : cell.campaigns) ?? []) {
      if (!/^\d{1,30}$/.test(id)) {
        problems.push(`${label}: ${kind} id ${JSON.stringify(id).slice(0, 40)} is not a Meta id.`);
        continue;
      }
      if (seen.has(id)) problems.push(`${kind} ${id} is in more than one cell.`);
      else {
        seen.add(id);
        entities.push({ id, kind });
      }
      ids.push(id);
    }
    return {
      name: cell.name,
      treatment_percentage: cell.treatment_percentage,
      ...(cell.control_percentage !== undefined ? { control_percentage: cell.control_percentage } : {}),
      ...(kind === "ad set" ? { adsets: ids } : { campaigns: ids }),
    };
  });
  return { cells: planned, entities, problems };
}

function planTimes(startTime: string, endTime: string): { start: number; end: number } {
  const start = unixSeconds(startTime, "start_time");
  const end = unixSeconds(endTime, "end_time", true);
  if (end <= start) throw new Error("end_time must be after start_time (Meta refuses it, subcode 1840010).");
  return { start, end };
}

type State = "canceled" | "scheduled" | "running" | "ended" | "of unknown state";

function stateOf(study: AdStudy, at = Math.floor(Date.now() / 1000)): State {
  if (study.canceled_time) return "canceled";
  const start = metaTimeSeconds(study.start_time);
  const end = metaTimeSeconds(study.end_time);
  if (start === undefined || end === undefined) return "of unknown state";
  if (start > at) return "scheduled";
  return end > at ? "running" : "ended";
}

const when = (value: string | undefined) => singleLine(value, 30) || "?";
const fence = (lines: string[]) => [ADVERTISER_CONTENT_OPEN, ...lines, ADVERTISER_CONTENT_CLOSE];
const why = (err: unknown) => singleLine(err instanceof Error ? err.message : String(err), 240);
const plural = (n: number) => `${n} stud${n === 1 ? "y" : "ies"}`;

function studyLine(study: AdStudy): string {
  return `• ${singleLine(study.name, 100) || "(unnamed)"} — study_id ${singleLine(study.id, 30)} — ${singleLine(study.type, 40) || "?"} — ${stateOf(study)} — ${when(study.start_time)} → ${when(study.end_time)}`;
}

function cellLine(cell: AdStudyCell): string {
  const ids = (list: AdStudyCell["adsets"]) => (list?.data ?? []).map((e) => singleLine(e.id, 30)).join(", ");
  return [
    `• ${singleLine(cell.name, 100) || "(unnamed)"} — cell_id ${singleLine(cell.id, 30)} — ${cell.treatment_percentage ?? "?"}%` +
      (cell.control_percentage !== undefined ? ` (control ${cell.control_percentage}%)` : ""),
    ...(ids(cell.adsets) ? [`ad sets ${ids(cell.adsets)}`] : []),
    ...(ids(cell.campaigns) ? [`campaigns ${ids(cell.campaigns)}`] : []),
  ].join(" — ");
}

async function accountBusiness(account: string): Promise<string> {
  const node = await metaApiClient.get<{ business?: { id?: string } }>(`/${account}`, { fields: "business{id}" });
  const id = node.business?.id;
  if (!id || !/^\d{1,30}$/.test(id)) {
    throw new Error(`${account} has no Business Manager Meta shows this token, and Meta creates studies on one. Pass business_id.`);
  }
  return id;
}

export function registerABTestingTools(server: McpServer): void {
  // ─── List studies ─────────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_studies",
    {
      description:
        "List the A/B tests and lift studies on an ad account, or on one campaign or ad set (entity_id), optionally of one type, " +
        "with their state (scheduled, running, ended, canceled). Meta does not list API-made studies on the account itself, so the " +
        "account's campaigns and ad sets are read with their studies (measured). Study names come inside an untrusted-content fence.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        entity_id: z.string().optional().describe("Only the studies of this campaign or ad set"),
        type: z.enum(LISTED_TYPES).optional().describe("Only studies of this type"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { ...READ },
    },
    async ({ account_id, entity_id, type, limit }) => {
      const account = normalizeAccountId(account_id);
      const studies = new Map<string, AdStudy>();
      let complete = true;
      const add = (list: AdStudy[] | undefined) => {
        for (const s of list ?? []) if (s.id && !studies.has(s.id)) studies.set(s.id, s);
      };

      let scope: string = account;
      if (entity_id !== undefined) {
        scope = validateNumericId(entity_id, "entity_id");
        const read = await readList<AdStudy>(`/${scope}/ad_studies`, { fields: FIELDS, limit: 100 }, 500);
        add(read.items);
        complete = read.complete;
      } else {
        const nested = `id,ad_studies.limit(${NESTED_LIMIT}){${FIELDS}}`;
        // An entity with more studies than the expansion holds has its own
        // list read to the end.
        const cutShort: string[] = [];
        for (const edge of ["campaigns", "adsets"]) {
          const read = await readList<{ id?: string; ad_studies?: { data?: AdStudy[]; paging?: { next?: string } } }>(
            `/${account}/${edge}`,
            { fields: nested, limit: 100 },
            2000,
          );
          for (const item of read.items) {
            add(item.ad_studies?.data);
            if (item.ad_studies?.paging?.next && item.id && /^\d{1,30}$/.test(item.id)) cutShort.push(item.id);
          }
          complete &&= read.complete;
        }
        for (const entity of cutShort.slice(0, MAX_FOLLOWED)) {
          const read = await readList<AdStudy>(`/${entity}/ad_studies`, { fields: FIELDS, limit: 100 }, 500);
          add(read.items);
          complete &&= read.complete;
        }
        if (cutShort.length > MAX_FOLLOWED) complete = false;
        const direct = await readList<AdStudy>(`/${account}/ad_studies`, { fields: FIELDS, limit: 100 }, 500);
        add(direct.items);
        complete &&= direct.complete;
      }

      const matching = [...studies.values()]
        .filter((s) => !type || s.type === type)
        .sort((a, b) => (metaTimeSeconds(b.start_time) ?? 0) - (metaTimeSeconds(a.start_time) ?? 0));
      const shown = matching.slice(0, limit);
      const lines = [
        `${plural(shown.length)} on ${scope}${type ? ` of type ${type}` : ""}${matching.length > limit ? ` (of ${matching.length}; raise limit to see more)` : ""}.`,
        ...(complete ? [] : ["The account's campaigns or ad sets could not all be read, so there may be more studies."]),
        ...(shown.length ? fence(shown.map(studyLine)) : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Create a study ───────────────────────────────────────────
  server.registerTool(
    "ads_create_ad_study",
    {
      description:
        `${WRITE_WARNING}Create an A/B test (SPLIT_TEST: cells of ad sets or campaigns compared with each other) or a lift study ` +
        "(LIFT: a held-back control group per cell, measured on objectives such as purchases on a pixel). Meta creates it on the " +
        "account's Business Manager (or business_id) and runs it between start_time and end_time. Check it first with " +
        "ads_experiment_check_eligibility: Meta has no dry run. Until it starts, ads_experiment_abtest_update_test can edit or cancel it.",
      inputSchema: {
        account_id: z.string().describe("Ad account the cells' campaigns or ad sets belong to"),
        business_id: z.string().optional().describe("Business Manager to create the study on; by default the account's own"),
        name: z.string().min(1).max(400).describe("Study name"),
        description: z.string().max(1000).optional(),
        type: z.enum(STUDY_TYPES).default("SPLIT_TEST"),
        start_time: timeInput("When the study starts"),
        end_time: timeInput("When it ends (a day means the end of that day)"),
        cells: z.array(cellInput).min(1).max(MAX_CELLS).describe("The cells: ad sets or campaigns, and each one's share"),
        objectives: z
          .array(z.object({
            name: z.string().min(1).max(100),
            type: z.enum(OBJECTIVE_TYPES).default("CONVERSIONS"),
            is_primary: z.boolean().default(false),
            pixel_id: z.string().optional().describe("Pixel whose events the objective counts"),
            event_names: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/)).min(1).max(20).optional().describe("e.g. [\"fb_pixel_purchase\"]"),
          }))
          .min(1)
          .max(10)
          .optional()
          .describe("What the study measures. Required for a lift study."),
        confidence_level: z.number().min(80).max(99).optional().describe("Confidence level for the study's report (%)"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, business_id, name, description, type, start_time, end_time, cells, objectives, confidence_level }) => {
      const account = normalizeAccountId(account_id);
      const business = business_id === undefined ? undefined : validateNumericId(business_id, "business_id");
      const { start, end } = planTimes(start_time, end_time);
      const plan = planCells(type, cells);
      if (plan.problems.length) throw new Error(plan.problems.join(" "));
      if (type === "LIFT" && !objectives?.length) {
        throw new Error("A lift study needs objectives: what it measures, such as purchases on a pixel.");
      }
      const objectiveBody = objectives?.map((o) => ({
        name: o.name,
        type: o.type,
        is_primary: o.is_primary,
        ...(o.pixel_id !== undefined ? { adspixels: [{ id: validateNumericId(o.pixel_id, "pixel_id"), ...(o.event_names ? { event_names: o.event_names } : {}) }] } : {}),
      }));

      const owner = business ?? await accountBusiness(account);
      const body: Record<string, string | number> = {
        name,
        type,
        start_time: start,
        end_time: end,
        cells: JSON.stringify(plan.cells),
      };
      if (type === "LIFT") {
        body.cooldown_start_time = start;
        body.observation_end_time = end;
      }
      if (description) body.description = description;
      if (confidence_level !== undefined) body.confidence_level = confidence_level;
      if (objectiveBody) body.objectives = JSON.stringify(objectiveBody);

      let created: { id: string };
      try {
        created = await metaApiClient.postForm<{ id: string }>(`/${owner}/ad_studies`, body);
      } catch (err) {
        if (wasRefused(err)) throw err;
        throw new Error(
          `Meta's answer was lost (${why(err)}), so the study may or may not exist. ` +
            `Look for it with ads_get_ad_studies with entity_id ${plan.entities[0].id} before creating it again.`,
        );
      }
      return {
        content: [{
          type: "text",
          text: `Study ${created.id} created (${type}) on Business Manager ${owner}: ${cells.length} cells, ` +
            `from ${new Date(start * 1000).toISOString()} to ${new Date(end * 1000).toISOString()}. ` +
            "Until it starts, ads_experiment_abtest_update_test can edit or cancel it.",
        }],
      };
    },
  );

  // ─── Study details ────────────────────────────────────────────
  server.registerTool(
    "ads_get_study_details",
    {
      description:
        "Get one A/B test or lift study: its type, state, times, cells (each with its share and its ad sets or campaigns) and objectives. " +
        "Names and descriptions come inside an untrusted-content fence.",
      inputSchema: {
        study_id: z.string().describe("Study ID"),
      },
      annotations: { ...READ },
    },
    async ({ study_id }) => {
      const id = validateNumericId(study_id, "study_id");
      const study = scrubbed(await metaApiClient.get<AdStudy>(`/${id}`, { fields: `${FIELDS},${CELL_FIELDS},${OBJECTIVE_FIELDS}` }));
      const cells = study.cells?.data ?? [];
      const objectives = study.objectives?.data ?? [];
      const lines = [
        `Study ${id}: ${singleLine(study.type, 40) || "?"}, ${stateOf(study)}, ${when(study.start_time)} → ${when(study.end_time)}.`,
        ...(study.cooldown_start_time || study.observation_end_time
          ? [`Cooldown from ${when(study.cooldown_start_time)}; observed until ${when(study.observation_end_time)}.`]
          : []),
        ...(study.results_first_available_date ? [`Results first available ${when(study.results_first_available_date)}.`] : []),
        `${cells.length} cell${cells.length === 1 ? "" : "s"}, ${objectives.length} objective${objectives.length === 1 ? "" : "s"}.`,
        ...fence([
          `Name: ${singleLine(study.name, 200) || "(unnamed)"}`,
          ...(study.description ? [`Description: ${singleLine(study.description, 400)}`] : []),
          ...cells.map(cellLine),
          ...objectives.map((o) => `• ${singleLine(o.name, 100) || "(unnamed)"} — ${singleLine(o.type, 40) || "?"}${o.is_primary ? " — primary" : ""}`),
        ]),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Check eligibility (official name) ────────────────────────
  server.registerTool(
    "ads_experiment_check_eligibility",
    {
      description:
        "Check whether an A/B test or lift study can be created before creating it: the account's Business Manager, the cells' shape, " +
        "that each campaign or ad set exists and belongs to the account, that none is already in a test that is running or scheduled " +
        "(Meta refuses that, subcode 1840001), and that the times are in order. Meta has no dry run for studies, so these are the checks " +
        "that can be made beforehand; Meta may still refuse at creation. Reads only.",
      inputSchema: {
        account_id: z.string().describe("Ad account the cells' campaigns or ad sets belong to"),
        business_id: z.string().optional().describe("Business Manager the study would be created on; by default the account's own"),
        type: z.enum(STUDY_TYPES).default("SPLIT_TEST"),
        cells: z.array(cellInput).min(1).max(MAX_CELLS),
        start_time: timeInput("When the study would start").optional(),
        end_time: timeInput("When it would end").optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, business_id, type, cells, start_time, end_time }) => {
      const account = normalizeAccountId(account_id);
      const plan = planCells(type, cells);
      const problems = [...plan.problems];
      const unconfirmed: string[] = [];
      const notes: string[] = [];

      if (start_time !== undefined && end_time !== undefined) {
        try {
          planTimes(start_time, end_time);
        } catch (err) {
          problems.push(why(err));
        }
      } else {
        notes.push("Times were not checked: give start_time and end_time to check them.");
      }

      if (business_id !== undefined) {
        validateNumericId(business_id, "business_id");
      } else {
        try {
          await accountBusiness(account);
        } catch (err) {
          problems.push(why(err));
        }
      }

      if (plan.entities.length > MAX_CHECKED) {
        problems.push(`This check reads at most ${MAX_CHECKED} campaigns or ad sets; the cells hold ${plan.entities.length}.`);
      } else {
        for (const { id, kind } of plan.entities) {
          try {
            const node = await metaApiClient.get<{ account_id?: string }>(`/${id}`, { fields: "id,account_id,effective_status" });
            const owner = node.account_id && /^(act_)?\d{1,30}$/.test(node.account_id) ? normalizeAccountId(node.account_id) : undefined;
            if (owner !== account) problems.push(`${kind} ${id} belongs to ${owner ?? "an account Meta did not name"}, not ${account}.`);
          } catch (err) {
            problems.push(`${kind} ${id} could not be read (${why(err)}).`);
            continue;
          }
          // A test is called eligible only when every study of every entity
          // was read and its state is known.
          try {
            const { items, complete } = await readList<AdStudy>(`/${id}/ad_studies`, { fields: FIELDS, limit: 100 }, 500);
            if (!complete) unconfirmed.push(`the studies of ${kind} ${id} could not all be read`);
            for (const s of items) {
              const state = stateOf(s);
              if (state === "running" || state === "scheduled") {
                problems.push(`${kind} ${id} is already in study ${singleLine(s.id, 30)} (${state}): Meta refuses an ad object in two tests active at once.`);
              } else if (state === "of unknown state") {
                unconfirmed.push(`${kind} ${id} is in study ${singleLine(s.id, 30)}, whose times Meta did not give, so whether it is still active is unknown`);
              }
            }
          } catch (err) {
            unconfirmed.push(`the studies of ${kind} ${id} could not be read (${why(err)})`);
          }
        }
      }

      const lines = [
        problems.length > 0
          ? `Not eligible: ${problems.length} problem${problems.length === 1 ? "" : "s"}.`
          : unconfirmed.length > 0
            ? "Not confirmed: nothing found that Meta would refuse, but some checks could not be completed."
            : "Eligible: nothing found that Meta would refuse.",
        ...problems.map((p) => `• ${p}`),
        ...unconfirmed.map((u) => `• Not checked: ${u}.`),
        ...notes.map((n) => `Note: ${n}`),
        "Meta has no dry run for studies (validate_only creates the study, measured), so these are the checks that can be made before creating one.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ─── Edit or cancel a test (official name) ────────────────────
  server.registerTool(
    "ads_experiment_abtest_update_test",
    {
      description:
        `${WRITE_WARNING}Edit or cancel an A/B test (or a lift study). ` +
        "edit: rename it, change its description, move its end (to a time still in the future), or, before it starts, change the cells' split " +
        "(every cell's percentage, since Meta sets them together). " +
        "cancel: a test that has not started is deleted and will not run. Meta does not cancel one that is running: move its end_time earlier instead. " +
        "Confirm with the human first.",
      inputSchema: {
        study_id: z.string().describe("Study ID"),
        action: z.enum(["edit", "cancel"]),
        name: z.string().min(1).max(400).optional(),
        description: z.string().max(1000).optional(),
        end_time: timeInput("New end").optional(),
        cell_percentages: z
          .array(z.object({ cell_id: z.string(), treatment_percentage: z.number().gt(0).max(100) }))
          .min(1)
          .max(MAX_CELLS)
          .optional()
          .describe("Before the start only: every cell's new share (cell_id from ads_get_study_details)"),
      },
      annotations: { ...DELETE },
    },
    async ({ study_id, action, name, description, end_time, cell_percentages }) => {
      const id = validateNumericId(study_id, "study_id");
      const study = scrubbed(await metaApiClient.get<AdStudy>(`/${id}`, { fields: FIELDS }));
      const state = stateOf(study);
      if (state === "canceled") throw new Error(`Study ${id} was already canceled.`);

      if (action === "cancel") {
        if (state === "running") {
          throw new Error(
            `Study ${id} is already running: Meta does not cancel a test once it has started. ` +
              "To end it sooner, edit its end_time to an earlier time that is still in the future.",
          );
        }
        if (state !== "scheduled") throw new Error(`Study ${id} is ${state}; there is nothing to cancel.`);
        try {
          await metaApiClient.delete(`/${id}`);
        } catch (err) {
          if (wasRefused(err)) throw err;
          throw new Error(`Meta's answer was lost (${why(err)}): study ${id} may or may not have been deleted. Read it with ads_get_study_details.`);
        }
        return { content: [{ type: "text", text: `Study ${id} was canceled before it started: Meta deleted it, so it will not run.` }] };
      }

      if (name === undefined && description === undefined && end_time === undefined && cell_percentages === undefined) {
        throw new Error("Nothing to change: give name, description, end_time or cell_percentages.");
      }
      const body: Record<string, string | number> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (end_time !== undefined) {
        const end = unixSeconds(end_time, "end_time", true);
        const start = metaTimeSeconds(study.start_time);
        if (state === "ended") throw new Error(`Study ${id} has ended; Meta does not move the end of a study that is over.`);
        if (end <= Math.floor(Date.now() / 1000)) throw new Error("end_time must be in the future.");
        if (start !== undefined && end <= start) throw new Error("end_time must be after start_time (Meta refuses it, subcode 1840010).");
        body.end_time = end;
      }
      if (cell_percentages !== undefined) {
        if (state !== "scheduled") throw new Error(`Study ${id} has started: Meta does not change the cells' split once a test runs.`);
        // Meta sets every cell's share together, so the split is sent only
        // when every cell was read.
        const cellsRead = await readList<{ id?: string }>(`/${id}/cells`, { fields: "id", limit: 100 }, MAX_CELLS);
        if (!cellsRead.complete) throw new Error(`The cells of study ${id} could not be read to the end, so no split was sent.`);
        const existing = cellsRead.items.map((c) => c.id).filter((c): c is string => typeof c === "string");
        const given = new Set(cell_percentages.map((c) => c.cell_id));
        const missing = existing.filter((c) => !given.has(c));
        const unknown = [...given].filter((c) => !existing.includes(c));
        if (missing.length) throw new Error(`Give every cell's percentage: Meta sets them together. Missing: ${missing.map((c) => singleLine(c, 30)).join(", ")}.`);
        if (unknown.length) throw new Error(`Study ${id} has no cell ${unknown.map((c) => JSON.stringify(c).slice(0, 40)).join(", ")}.`);
        body.cells = JSON.stringify(cell_percentages.map((c) => ({ id: c.cell_id, treatment_percentage: c.treatment_percentage })));
      }

      try {
        await metaApiClient.postForm<{ success?: boolean }>(`/${id}`, body);
      } catch (err) {
        if (wasRefused(err)) throw err;
        throw new Error(`Meta's answer was lost (${why(err)}): the change to study ${id} may or may not have gone through. Read it with ads_get_study_details.`);
      }
      const after = scrubbed(await metaApiClient.get<AdStudy>(`/${id}`, { fields: "name,end_time" }));
      return {
        content: [{
          type: "text",
          text: [`Study ${id} updated; it now ends ${when(after.end_time)}.`, ...fence([`Name: ${singleLine(after.name, 200) || "(unnamed)"}`])].join("\n"),
        }],
      };
    },
  );
}
