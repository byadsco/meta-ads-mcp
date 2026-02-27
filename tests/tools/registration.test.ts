import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/index.js";
import { createMockMcpServer } from "../setup.js";

describe("registerAllTools", () => {
  it("registers exactly 71 tools total", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(71);
  });

  it("registers all tools with unique names", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("all tool names start with meta_ads_", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    for (const tool of server._registeredTools) {
      expect(tool.name).toMatch(/^meta_ads_/);
    }
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

  it("includes expected core tools", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);

    // Core account/campaign tools
    expect(names).toContain("meta_ads_get_ad_accounts");
    expect(names).toContain("meta_ads_get_campaigns");
    expect(names).toContain("meta_ads_create_campaign");
    expect(names).toContain("meta_ads_get_insights");

    // Token management tools
    expect(names).toContain("meta_ads_list_tokens");
    expect(names).toContain("meta_ads_set_active_token");
    expect(names).toContain("meta_ads_register_token");

    // Extended feature tools
    expect(names).toContain("meta_ads_get_lead_forms");
    expect(names).toContain("meta_ads_get_custom_audiences");
    expect(names).toContain("meta_ads_get_ad_preview");
    expect(names).toContain("meta_ads_get_pixels");
    expect(names).toContain("meta_ads_get_ad_comments");
    expect(names).toContain("meta_ads_get_ad_rules");
    expect(names).toContain("meta_ads_get_ad_studies");
    expect(names).toContain("meta_ads_create_async_report");
    expect(names).toContain("meta_ads_get_billing_info");
  });

  it("registers correct tool count per module", () => {
    const server = createMockMcpServer();
    registerAllTools(server as never);

    const names = server._registeredTools.map((t) => t.name);

    // Count tools by prefix pattern for each module
    const accountTools = names.filter((n) => n.includes("account") || n === "meta_ads_get_pages");
    expect(accountTools.length).toBeGreaterThanOrEqual(3);

    const campaignTools = names.filter((n) => n.includes("campaign"));
    expect(campaignTools.length).toBeGreaterThanOrEqual(4);

    const billingTools = names.filter((n) => n.includes("billing") || n.includes("spend"));
    expect(billingTools.length).toBeGreaterThanOrEqual(3);
  });
});
