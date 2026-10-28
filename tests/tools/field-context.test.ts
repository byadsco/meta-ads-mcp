import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIELD_CONTEXT, registerFieldContextTools } from "../../src/tools/field-context.js";
import { objectiveEnum } from "../../src/tools/campaigns.js";
import { CAMPAIGN_DEFAULT_FIELDS } from "../../src/meta/types/campaign.js";
import { ADSET_DEFAULT_FIELDS } from "../../src/meta/types/adset.js";
import { AD_DEFAULT_FIELDS } from "../../src/meta/types/ad.js";
import { MINOR_UNIT_NOTE } from "../../src/meta/currency.js";
import { createMockMcpServer } from "../setup.js";

type TextResult = { content: Array<{ type: string; text: string }> };

async function context(args: Record<string, unknown> = {}): Promise<string> {
  const server = createMockMcpServer();
  registerFieldContextTools(server as never);
  const result = await server._registeredTools[0].handler(args) as TextResult;
  return result.content.map((c) => c.text).join("\n");
}
const lineOf = (text: string, field: string) => text.split("\n").find((l) => l.startsWith(`• ${field} `)) ?? "";

describe("ads_get_field_context", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is registered under Meta's official name, as a read", () => {
    const server = createMockMcpServer();
    registerFieldContextTools(server as never);
    expect(server._registeredTools[0].name).toBe("ads_get_field_context");
    expect(server._registeredTools[0].annotations).toEqual({ readOnlyHint: true });
  });

  it("answers from its own table, without calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await context({ entity_type: "campaign" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives a field's type, its levels, the filter Meta applies and its values", async () => {
    const line = lineOf(await context({ entity_type: "campaign" }), "objective");

    expect(line).toContain("enum");
    expect(line).toContain("filter on campaign: IN");
    for (const value of objectiveEnum.options) expect(line).toContain(value);
  });

  it("gives the filters measured at each level, the paths to parents among them", async () => {
    const adSet = await context({ entity_type: "ad_set" });
    expect(lineOf(adSet, "optimization_goal")).toContain("filter on ad set: IN");
    expect(lineOf(adSet, "campaign.objective")).toContain("filter on ad set: IN");
    expect(lineOf(adSet, "campaign.id")).toContain("filter on ad set: IN");

    const ad = await context({ entity_type: "ad" });
    expect(lineOf(ad, "adset.id")).toContain("filter on ad: IN");
    expect(lineOf(ad, "name")).toContain("filter on ad: CONTAIN");
    expect(lineOf(ad, "effective_status")).toContain("filter on ad: IN");
  });

  it("lists the effective_status values Meta gives, and says where it gave them", async () => {
    const line = lineOf(await context({ fields: ["effective_status"] }), "effective_status");
    for (const value of ["ACTIVE", "PENDING_REVIEW", "DISAPPROVED", "ADSET_PAUSED", "WITH_ISSUES"]) expect(line).toContain(value);
    expect(line).toContain("listed by Meta for campaigns and ad sets");
  });

  it("gives no effective_status values for ads, where Meta listed none", async () => {
    const line = lineOf(await context({ entity_type: "ad" }), "effective_status");
    expect(line).not.toContain("PENDING_REVIEW");
    expect(line).toMatch(/Meta lists no values for ads/);
  });

  it("says when values are the ones this server's create tools accept, not a list from Meta", async () => {
    expect(lineOf(await context({ fields: ["objective"] }), "objective")).toContain("values this server's create tools accept");
  });

  describe("every claim is backed by the recorded probe", () => {
    const probe = JSON.parse(readFileSync(new URL("../fixtures/meta-field-probe-2026-10-28.json", import.meta.url), "utf8")) as {
      exists: Record<string, string[]>;
      filters: Record<string, Record<string, "filters" | "refused">>;
      effective_status_values: Record<string, string[] | null>;
    };

    it("a field is said to exist only on levels where the probe found it", () => {
      const unbacked = Object.entries(FIELD_CONTEXT).flatMap(([field, info]) =>
        info.levels.filter((level) => !probe.exists[level].includes(field)).map((level) => `${level}.${field}`));
      expect(unbacked).toEqual([]);
    });

    it("a filter is claimed, or denied, only as the probe measured it", () => {
      const unbacked = Object.entries(FIELD_CONTEXT).flatMap(([field, info]) =>
        Object.entries(info.filter ?? {})
          .filter(([level, operator]) => probe.filters[level]?.[field] !== (operator === "no" ? "refused" : "filters"))
          .map(([level]) => `${level}.${field}`));
      expect(unbacked).toEqual([]);
    });

    it("effective_status values are the probe's, on the levels it got them", () => {
      const info = FIELD_CONTEXT.effective_status;
      expect([...(info.values ?? [])]).toEqual(probe.effective_status_values.campaign);
      expect([...(info.valuesLevels ?? [])].sort()).toEqual(
        Object.entries(probe.effective_status_values).filter(([, v]) => v !== null).map(([level]) => level).sort(),
      );
    });
  });

  it("does not claim a filter it did not measure", async () => {
    expect(lineOf(await context({ entity_type: "ad_set" }), "status")).not.toContain("filter on ad set");
  });

  it("states the unit of every money field, and that a campaign cap is not the account cap", async () => {
    const text = await context({ fields: ["daily_budget", "spend_cap"] });

    expect(lineOf(text, "daily_budget")).toContain(MINOR_UNIT_NOTE);
    expect(lineOf(text, "spend_cap")).toContain("not the account spend cap");
  });

  it("names filters for times as Unix seconds", async () => {
    expect(lineOf(await context({ fields: ["created_time"] }), "created_time")).toMatch(/Unix seconds/);
  });

  it("lists only the fields asked for, and says which it does not know", async () => {
    const text = await context({ fields: ["objective", "no_such_field"] });

    expect(lineOf(text, "objective")).not.toBe("");
    expect(lineOf(text, "name")).toBe("");
    expect(text).toMatch(/Not in this table: no_such_field/);
  });

  it("limits the list to one level when entity_type is given", async () => {
    const text = await context({ entity_type: "ad" });
    expect(lineOf(text, "creative")).not.toBe("");
    expect(lineOf(text, "objective")).toBe("");
  });

  it.each([
    ["campaign", CAMPAIGN_DEFAULT_FIELDS],
    ["ad_set", ADSET_DEFAULT_FIELDS],
    ["ad", AD_DEFAULT_FIELDS],
  ] as const)("describes every %s field ads_get_ad_entities returns by default", (level, defaults) => {
    const missing = defaults
      .map((f) => f.replace(/\{.*\}$/, ""))
      .filter((f) => !(FIELD_CONTEXT[f]?.levels as readonly string[] | undefined)?.includes(level));
    expect(missing).toEqual([]);
  });
});
