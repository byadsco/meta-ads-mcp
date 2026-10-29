import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/tools/index.js";
import { MINOR_UNIT_NOTE } from "../../src/meta/currency.js";
import { createMockMcpServer } from "../setup.js";

describe("registerAllTools", () => {
  it("registers exactly 162 tools total", () => {
    // 79 v2 tools renamed (with account_insights removed → 79) + 14 new in v3 +
    //   3 audience-sharing tools (share / unshare / get-shared-accounts) +
    //   1 invoices tool (ads_get_invoices) +
    //   27 WhatsApp Business tools (whatsapp_*) +
    //   1 UTM editing tool (ads_update_ad_url_tags) +
    //   1 bulk video-ad macro (ads_bulk_create_video_ads) +
    //   1 creative media tool (ads_get_creative_media) +
    //   8 Ad Library scraping tools (ads_library_*, Apify-backed) +
    //   1 video media tool (ads_get_video_media) +
    //   1 Ad Library details tool (ads_library_get_ad_details) +
    //   1 Gemini video analysis tool (ads_analyze_video) +
    //   3 Gemini key management tools (ads_register_gemini_key / status / delete) +
    //   1 ad dossier tool (ads_get_ad_dossier) +
    //   2 social proof tools (ads_duplicate_ad / ads_get_ad_social_proof) +
    //   4 Business Manager access tools (ads_get_business_users / ads_get_asset_users /
    //     ads_assign_user_to_asset / ads_remove_user_from_asset) +
    //   1 locale search tool (ads_search_locales) +
    //   7 official-parity tools (ads_get_ad_account_pages / ads_get_user_pages /
    //     ads_get_creative_ads / ads_boost_ig_post / ads_get_field_context /
    //     ads_account_get_activity_logs / ads_library_search) +
    //   2 experiment tools (ads_experiment_check_eligibility / ads_experiment_abtest_update_test).
    const server = createMockMcpServer();
    registerAllTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(162);
  });

  it("registers all tools with unique names", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("all tool names start with ads_ or whatsapp_ (no meta_ prefix)", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      expect(tool.name).toMatch(/^(ads|whatsapp)_/);
      expect(tool.name).not.toMatch(/^meta_/);
    }
  });

  it("registers exactly 27 whatsapp_ tools", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const whatsappTools = server._registeredTools.filter((t) =>
      t.name.startsWith("whatsapp_"),
    );
    expect(whatsappTools.length).toBe(27);
  });

  it("registers exactly 10 ads_library_ tools: nine Apify-backed and Meta's own search", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools
      .map((t) => t.name)
      .filter((n) => n.startsWith("ads_library_"));

    expect(names.sort()).toEqual([
      "ads_library_abort_run",
      "ads_library_delete_apify_token",
      "ads_library_get_ad_details",
      "ads_library_get_apify_token_status",
      "ads_library_get_results",
      "ads_library_get_run_status",
      "ads_library_list_runs",
      "ads_library_register_apify_token",
      "ads_library_scrape",
      "ads_library_search",
    ]);
  });

  it("all tools have non-empty descriptions", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("all tools have handler functions", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("all tools declare ToolAnnotations", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      expect(tool.annotations).toBeDefined();
      const a = tool.annotations!;
      // Either readOnlyHint=true OR a destructiveHint must be present
      const isAnnotated =
        a.readOnlyHint === true
        || a.destructiveHint !== undefined;
      expect(isAnnotated).toBe(true);
    }
  });

  it("write tools include the warning prefix in description", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      const isWrite =
        tool.annotations?.readOnlyHint !== true;
      if (isWrite) {
        expect(tool.description).toContain("⚠️");
      }
    }
  });

  it("includes expected core tools", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);

    // Core account/campaign tools
    expect(names).toContain("ads_get_ad_accounts");
    expect(names).toContain("ads_get_campaigns");
    expect(names).toContain("ads_create_campaign");
    expect(names).toContain("ads_get_insights");
    expect(names).toContain("ads_get_creative_details");
    expect(names).toContain("ads_get_creative_media");
    expect(names).toContain("ads_get_video_media");
    expect(names).toContain("ads_update_ad_url_tags");
    expect(names).toContain("ads_clone_ad_set_bundle");
    expect(names).toContain("ads_duplicate_ad");
    expect(names).toContain("ads_get_ad_social_proof");

    // Token management tools
    expect(names).toContain("ads_list_tokens");
    expect(names).toContain("ads_set_active_token");
    expect(names).toContain("ads_register_token");
    expect(names).toContain("ads_delete_token");

    // Instagram tools
    expect(names).toContain("ads_get_instagram_account");
    expect(names).toContain("ads_get_instagram_media");

    // Extended feature tools
    expect(names).toContain("ads_get_lead_forms");
    expect(names).toContain("ads_get_custom_audiences");
    expect(names).toContain("ads_get_ad_preview");
    expect(names).toContain("ads_get_pixels");
    expect(names).toContain("ads_get_ad_comments");
    expect(names).toContain("ads_get_ad_rules");
    expect(names).toContain("ads_get_ad_studies");
    expect(names).toContain("ads_create_async_report");
    expect(names).toContain("ads_get_billing_info");
    expect(names).toContain("ads_get_invoices");

    // Business Manager access tools
    expect(names).toContain("ads_get_business_users");
    expect(names).toContain("ads_get_asset_users");
    expect(names).toContain("ads_assign_user_to_asset");
    expect(names).toContain("ads_remove_user_from_asset");

    // WhatsApp Business tools
    expect(names).toContain("whatsapp_get_business_accounts");
    expect(names).toContain("whatsapp_get_phone_numbers");
    expect(names).toContain("whatsapp_get_templates");
    expect(names).toContain("whatsapp_create_template");
    expect(names).toContain("whatsapp_delete_template");
    expect(names).toContain("whatsapp_get_flows");
    expect(names).toContain("whatsapp_get_qr_codes");
    expect(names).toContain("whatsapp_subscribe_webhook");

    // Renamed in v3
    expect(names).toContain("ads_get_pages_for_business");
    expect(names).toContain("ads_create_ad_set");
    expect(names).toContain("ads_update_ad_set");
    expect(names).toContain("ads_delete_ad_set");
    expect(names).toContain("ads_get_ad_sets");
    expect(names).toContain("ads_get_ad_set_details");

    // Removed in v3
    expect(names).not.toContain("ads_get_account_insights");
    expect(names).not.toContain("meta_ads_get_account_insights");
  });

  it("registers correct tool count per module", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);

    const accountTools = names.filter((n) => n.includes("account") || n === "ads_get_pages_for_business");
    expect(accountTools.length).toBeGreaterThanOrEqual(3);

    const campaignTools = names.filter((n) => n.includes("campaign"));
    expect(campaignTools.length).toBeGreaterThanOrEqual(4);

    const billingTools = names.filter(
      (n) => n.includes("billing") || n.includes("spend") || n.includes("invoice"),
    );
    expect(billingTools.length).toBeGreaterThanOrEqual(4);
  });
});

describe("money amounts in what a model reads on tools/list", () => {
  const AMOUNT_PARAMETERS = ["daily_budget", "lifetime_budget", "bid_amount", "budget_value"];

  interface Published {
    name: string;
    /** The tool description and every parameter description, nested ones included. */
    descriptions: string[];
    parameters: Set<string>;
  }

  const collect = (node: unknown, descriptions: string[], parameters: Set<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item, descriptions, parameters);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.description === "string") descriptions.push(record.description);
    if (typeof record.properties === "object" && record.properties !== null) {
      for (const parameter of Object.keys(record.properties)) parameters.add(parameter);
    }
    for (const value of Object.values(record)) collect(value, descriptions, parameters);
  };

  const published = (): Published[] => {
    const server = createMockMcpServer();
    registerAllTools(server as never);
    return server._registeredTools.map((tool) => {
      const descriptions = [tool.description];
      const parameters = new Set<string>();
      const shape = tool.schema as Record<string, z.ZodType> | undefined;
      if (shape) collect(z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }), descriptions, parameters);
      return { name: tool.name, descriptions, parameters };
    });
  };

  const saysCents = (text: string): boolean => /\bcents?\b/i.test(text);
  const namesWholeUnitCurrencies = (text: string): boolean => /whole units/i.test(text) && /\bCOP\b/.test(text);

  it("reads the description of every parameter, nested ones included", () => {
    const clone = published().find((tool) => tool.name === "ads_clone_ad_set_bundle");
    expect(clone?.descriptions).toContain("Name for the cloned ad set");
    expect(clone?.parameters.has("daily_budget")).toBe(true);
  });

  it("no description says 'cents' without itself naming the currencies that have none", () => {
    const offenders = published()
      .flatMap((tool) => tool.descriptions
        .filter((text) => saysCents(text) && !namesWholeUnitCurrencies(text))
        .map((text) => `${tool.name}: ${text}`));

    expect(offenders).toEqual([]);
  });

  it("every tool that takes a budget or a bid carries the minor-unit note", () => {
    const taking = published().filter((tool) => AMOUNT_PARAMETERS.some((parameter) => tool.parameters.has(parameter)));

    expect(taking.map((tool) => tool.name).sort()).toEqual([
      "ads_clone_ad_set_bundle",
      "ads_create_ad_set",
      "ads_create_budget_schedule",
      "ads_create_campaign",
      "ads_update_ad_set",
      "ads_update_campaign",
    ]);
    for (const tool of taking) {
      const noted = tool.descriptions.filter((text) => text.includes(MINOR_UNIT_NOTE));
      expect(noted, tool.name).toHaveLength(1);
      expect(namesWholeUnitCurrencies(noted[0]), tool.name).toBe(true);
    }
  });

  it("the generic updater states the unit too, since its amounts travel in a free-form object", () => {
    const generic = published().find((tool) => tool.name === "ads_update_entity");
    expect(generic?.descriptions.some((text) => text.includes(MINOR_UNIT_NOTE))).toBe(true);
  });

  // Verified against a live USD account: the cap is written in whole
  // currency (1000000 sent, "100000000" read back), unlike budgets and bids.
  describe("the account spend cap, which is not in the minor unit", () => {
    const spendCap = () => published().find((tool) => tool.name === "ads_update_spend_cap")!;

    it("is the only tool that takes a spend_cap besides a campaign's own, which is in the minor unit", () => {
      const taking = published().filter((tool) => tool.parameters.has("spend_cap")).map((tool) => tool.name);
      expect(taking.sort()).toEqual(["ads_create_campaign", "ads_update_spend_cap"]);
    });

    // Measured on a USD account: 5000 is refused under the $100 minimum and
    // 10000 reads back as 10000.
    it("a campaign's spend_cap says it is in the budgets' unit, not the account cap's", () => {
      const campaign = published().find((tool) => tool.name === "ads_create_campaign")!;
      const text = campaign.descriptions.find((description) => /spend over its lifetime/.test(description)) ?? "";
      expect(text).toMatch(/same unit as daily_budget/);
      expect(text).toMatch(/NOT the standard unit of the account spend cap \(ads_update_spend_cap\)/);
      expect(text).toMatch(/10000 = USD 100\.00/);
    });

    it.each(["the tool description", "the parameter description"])("%s names the standard unit with an example of each kind", (which) => {
      const [tool, ...parameters] = spendCap().descriptions;
      const text = which === "the tool description" ? tool : parameters.find((description) => /spend cap/i.test(description)) ?? "";
      expect(text).toMatch(/standard unit/);
      expect(text).toMatch(/500 = USD 500\.00/);
      expect(text).toMatch(/50000 = COP 50,000/);
    });

    it("says plainly that this is not the unit of daily_budget", () => {
      expect(spendCap().descriptions[0]).toMatch(/NOT the minor unit used for daily_budget/);
    });

    it("never carries the minor-unit note or the word cents", () => {
      for (const text of spendCap().descriptions) {
        expect(text).not.toContain(MINOR_UNIT_NOTE);
        expect(text).not.toMatch(/minor unit as Meta defines it|hundredths/);
        expect(saysCents(text)).toBe(false);
      }
    });

    it("warns that setting a cap restarts the amount-spent counter, and says how to remove one", () => {
      expect(spendCap().descriptions[0]).toMatch(/restarts the account's amount-spent counter/);
      expect(spendCap().descriptions.join(" ")).toMatch(/0 removes the cap/);
    });
  });
});
