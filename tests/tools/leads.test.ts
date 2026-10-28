import { z } from "zod";
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
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerLeadTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_lead_forms",
      "ads_get_leads",
      "ads_get_ad_leads",
      "ads_create_lead_form",
    ]);
  });

  describe("ads_get_lead_forms handler", () => {
    it("returns formatted lead form list", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      const mockData = {
        data: [
          {
            id: "5001",
            name: "Contact Form",
            status: "ACTIVE",
            leads_count: 150,
          },
        ],
      };

      stubPage(mockData);

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        page_id: "60123",
        limit: 25,
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 lead form(s)");
      expect(result.content[0].text).toContain("Contact Form");
      expect(result.content[0].text).toContain("ACTIVE");
    });

    it("reads the forms with a Page token, which Meta requires (#190), and never shows it", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      stubPage({ data: [] });

      const result = await server._registeredTools[0].handler({ page_id: "60123", limit: 25 });

      expect(callSummary()).toEqual(["GET /60123", "GET /60123/leadgen_forms"]);
      expect(tokenOf(1)).toBe(PAGE_TOKEN);
      expect(JSON.stringify(result)).not.toContain(PAGE_TOKEN);
    });

    it("asks only for lead form fields, with no expansion that could reach the Page's own token", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      vi.stubGlobal("fetch", vi.fn());

      for (const fields of [["id", "page{access_token}"], ["page"], ["id,access_token"]]) {
        await expect(server._registeredTools[0].handler({ page_id: "60123", limit: 25, fields })).rejects.toThrow(/fields/);
      }
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("still asks for the form's own fields callers could ask for before", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      const schema = z.object(server._registeredTools[0].schema as z.ZodRawShape);
      const fields = ["id", "privacy_policy_url", "page_id", "allow_organic_lead", "follow_up_action_text"];
      stubPage({ data: [] });

      expect(schema.safeParse({ page_id: "60123", fields }).success).toBe(true);
      await server._registeredTools[0].handler({ page_id: "60123", limit: 25, fields });

      expect(new URL(String(vi.mocked(fetch).mock.calls[1][0])).searchParams.get("fields")).toBe(fields.join(","));
    });

    it("drops any credential Meta puts in a form, wherever it is", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      stubPage({ data: [{ id: "5001", name: "Form", status: "ACTIVE", follow_up_action_url: `https://example.com/?access_token=${PAGE_TOKEN}`, extra: { access_token: PAGE_TOKEN } }] });

      const result = await server._registeredTools[0].handler({ page_id: "60123", limit: 25 });

      expect(JSON.stringify(result)).not.toContain(PAGE_TOKEN);
    });
  });

  describe("ads_get_leads handler", () => {
    it("returns lead data with summary", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      const mockData = {
        data: [
          {
            id: "7001",
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
        form_id: "5001",
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
        form_id: "5001",
        limit: 100,
        fields: undefined,
        filtering: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("No leads found");
    });
  });

  describe("ads_create_lead_form handler", () => {
    it("creates a lead form and returns result", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);

      stubPage({ id: "50001" });

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        page_id: "60123",
        name: "New Form",
        questions: [
          { type: "EMAIL" },
          { type: "FULL_NAME" },
        ],
        privacy_policy_url: "https://example.com/privacy",
        follow_up_action_url: "https://example.com/thanks",
        locale: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Lead form created successfully");
      expect(result.content[0].text).toContain("50001");
      expect(result.content[0].text).toContain("Questions: 2");
    });

    it("creates the form with a Page token, which Meta requires (#190), and never shows it", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      stubPage({ id: "50001" });

      const result = await server._registeredTools[3].handler({
        page_id: "60123", name: "Form", questions: [{ type: "EMAIL" }], privacy_policy_url: "https://example.com/privacy", follow_up_action_url: "https://example.com/thanks",
      }) as { content: Array<{ text: string }> };

      expect(callSummary()).toEqual(["GET /60123", "POST /60123/leadgen_forms"]);
      expect(tokenOf(1)).toBe(PAGE_TOKEN);
      expect(JSON.stringify(result)).not.toContain(PAGE_TOKEN);
    });

    it("sends multiple-choice questions, the context card, the thank-you screen and the privacy link text", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      stubPage({ id: "50001" });

      await server._registeredTools[3].handler({
        page_id: "60123",
        name: "Form",
        questions: [
          { type: "FULL_NAME" },
          { type: "CUSTOM", key: "interest", label: "What interests you?", options: [{ value: "Casino", key: "casino" }, { value: "Sports", key: "sports" }] },
        ],
        privacy_policy_url: "https://example.com/privacy",
        privacy_policy_link_text: "Privacy",
        context_card: { title: "Before you start", content: ["We call within a day."], style: "PARAGRAPH_STYLE" },
        thank_you_page: { title: "Thanks", body: "We will be in touch.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com/" },
        locale: "es_LA",
      });

      const body = new URLSearchParams(String(vi.mocked(fetch).mock.calls[1][1]?.body));
      expect(JSON.parse(body.get("questions")!)[1]).toEqual({ type: "CUSTOM", key: "interest", label: "What interests you?", options: [{ value: "Casino", key: "casino" }, { value: "Sports", key: "sports" }] });
      expect(JSON.parse(body.get("privacy_policy")!)).toEqual({ url: "https://example.com/privacy", link_text: "Privacy" });
      expect(JSON.parse(body.get("context_card")!)).toEqual({ title: "Before you start", content: ["We call within a day."], style: "PARAGRAPH_STYLE" });
      expect(JSON.parse(body.get("thank_you_page")!)).toEqual({ title: "Thanks", body: "We will be in touch.", button_type: "VIEW_WEBSITE", button_text: "Visit", website_url: "https://example.com/" });
      expect(body.get("locale")).toBe("es_LA");
    });

    it("needs a thank-you screen or a follow-up URL, which Meta requires (subcode 1892085), before calling Meta", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      vi.stubGlobal("fetch", vi.fn());

      await expect(server._registeredTools[3].handler({
        page_id: "60123", name: "Form", questions: [{ type: "PHONE" }], privacy_policy_url: "https://example.com/privacy",
      })).rejects.toThrow(/thank_you_page or follow_up_action_url/);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("needs a key on every multiple-choice answer: Meta fails without one", () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      const schema = z.object(server._registeredTools[3].schema as z.ZodRawShape);

      const question = { type: "CUSTOM", key: "k", label: "L", options: [{ value: "A", key: "a" }, { value: "B" }] };
      expect(schema.safeParse({ page_id: "1", name: "F", questions: [question], privacy_policy_url: "https://e.com" }).success).toBe(false);
    });

    it("refuses options on a question that is not CUSTOM, before calling Meta", async () => {
      const server = createMockMcpServer();
      registerLeadTools(server as never);
      vi.stubGlobal("fetch", vi.fn());

      await expect(server._registeredTools[3].handler({
        page_id: "60123", name: "Form", questions: [{ type: "EMAIL", options: [{ value: "a" }] }], privacy_policy_url: "https://example.com/privacy",
      })).rejects.toThrow(/options/);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });
});

const PAGE_TOKEN = "page-token-never-shown";

// GET /<page> answers with a Page token; every other call gets `response`.
function stubPage(response: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(input).pathname.replace(/^\/v[\d.]+/, "");
    return mockFetchResponse(/^\/\d+$/.test(path) && new URL(input).searchParams.get("fields") === "access_token"
      ? { id: "60123", access_token: PAGE_TOKEN }
      : response);
  }));
}

function callSummary(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url)).pathname.replace(/^\/v[\d.]+/, "")}`);
}

function tokenOf(call: number): string | null {
  const [url, init] = vi.mocked(fetch).mock.calls[call];
  return new URL(String(url)).searchParams.get("access_token") ?? new URLSearchParams(String(init?.body ?? "")).get("access_token");
}
