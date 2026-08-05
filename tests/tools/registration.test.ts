import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { createMockMcpServer } from "../setup.js";

describe("registerAllTools", () => {
  it("registers exactly 125 tools total", () => {
    // 79 v2 tools renamed (with account_insights removed → 79) + 14 new in v3 +
    //   3 audience-sharing tools (share / unshare / get-shared-accounts) +
    //   1 invoices tool (ads_get_invoices) +
    //   27 WhatsApp Business tools (whatsapp_*) +
    //   1 UTM editing tool (ads_update_ad_url_tags).
    const server = createMockMcpServer();
    registerAllTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(125);
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
    expect(names).toContain("ads_update_ad_url_tags");
    expect(names).toContain("ads_clone_ad_set_bundle");

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
