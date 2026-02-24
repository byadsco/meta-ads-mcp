import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerLeadTools } from "../../src/tools/leads.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerLeadTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 4 tools", () => {
    const server = createMockMcpServer();
    registerLeadTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(4);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerLeadTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "meta_ads_get_lead_forms",
      "meta_ads_get_leads",
      "meta_ads_get_ad_leads",
      "meta_ads_create_lead_form",
    ]);
  });

  describe("meta_ads_get_lead_forms handler", () => {
    it("returns formatted lead form list", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      const mockData = {
        data: [
          {
            id: "form_1",
            name: "Contact Form",
            status: "ACTIVE",
            leads_count: 150,
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        page_id: "page_123",
        limit: 25,
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 lead form(s)");
      expect(result.content[0].text).toContain("Contact Form");
      expect(result.content[0].text).toContain("ACTIVE");
    });
  });

  describe("meta_ads_get_leads handler", () => {
    it("returns lead data with summary", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      const mockData = {
        data: [
          {
            id: "lead_1",
            created_time: "2024-01-15T10:00:00",
            field_data: [
              { name: "email", values: ["test@example.com"] },
              { name: "full_name", values: ["John Doe"] },
            ],
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        form_id: "form_1",
        limit: 100,
        fields: undefined,
        filtering: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 lead(s)");
      expect(result.content[0].text).toContain("email: test@example.com");
    });

    it("handles empty leads", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        form_id: "form_1",
        limit: 100,
        fields: undefined,
        filtering: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("No leads found");
    });
  });

  describe("meta_ads_create_lead_form handler", () => {
    it("creates a lead form and returns result", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "form_new_1" })));

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        page_id: "page_123",
        name: "New Form",
        questions: [
          { type: "EMAIL" },
          { type: "FULL_NAME" },
        ],
        privacy_policy_url: "https://example.com/privacy",
        follow_up_action_url: undefined,
        locale: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Lead form created successfully");
      expect(result.content[0].text).toContain("form_new_1");
      expect(result.content[0].text).toContain("Questions: 2");
    });
  });
});
