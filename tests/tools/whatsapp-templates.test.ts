import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWhatsAppTemplateTools } from "../../src/tools/whatsapp-templates.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerWhatsAppTemplateTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 6 tools", () => {
    const server = createMockMcpServer();
    registerWhatsAppTemplateTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerWhatsAppTemplateTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "whatsapp_get_templates",
      "whatsapp_create_template",
      "whatsapp_update_template",
      "whatsapp_delete_template",
      "whatsapp_get_analytics",
      "whatsapp_get_template_analytics",
    ]);
  });

  describe("whatsapp_get_templates handler", () => {
    it("lists templates with filters", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: [
            { id: "801", name: "order_update", status: "APPROVED", category: "UTILITY", language: "es_MX" },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        waba_id: "111",
        template_id: undefined,
        name: undefined,
        status: "APPROVED",
        category: undefined,
        language: undefined,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 template(s)");
      expect(result.content[0].text).toContain("order_update");

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/message_templates");
      expect(url.searchParams.get("status")).toBe("APPROVED");
    });

    it("handles empty template list", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        waba_id: "111",
        template_id: undefined,
        name: undefined,
        status: undefined,
        category: undefined,
        language: undefined,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("No message templates found");
    });
  });

  describe("whatsapp_create_template handler", () => {
    it("posts a JSON body with the components array", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ id: "801", status: "PENDING", category: "UTILITY" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const components = [
        { type: "BODY", text: "Your order {{1}} has shipped." },
        { type: "FOOTER", text: "Reply STOP to opt out" },
      ];

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        waba_id: "111",
        name: "order_shipped",
        category: "UTILITY",
        language: "es_MX",
        components,
        allow_category_change: true,
        parameter_format: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Template "order_shipped"');
      expect(result.content[0].text).toContain("PENDING");

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/message_templates");
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init.body as string);
      expect(body.components).toEqual(components);
      expect(body.name).toBe("order_shipped");
      expect(body.allow_category_change).toBe(true);
    });
  });

  describe("whatsapp_update_template handler", () => {
    it("rejects when no editable field is provided", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const handler = server._registeredTools[2].handler;
      await expect(
        handler({
          template_id: "801",
          components: undefined,
          category: undefined,
          message_send_ttl_seconds: undefined,
        }),
      ).rejects.toThrow(/at least one/i);
    });
  });

  describe("whatsapp_delete_template handler", () => {
    it("sends DELETE with name and hsm_id as query params", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        waba_id: "111",
        name: "order_shipped",
        hsm_id: "801",
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Template "order_shipped"');

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/message_templates");
      expect(url.searchParams.get("name")).toBe("order_shipped");
      expect(url.searchParams.get("hsm_id")).toBe("801");
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("DELETE");
    });
  });

  describe("whatsapp_get_analytics handler", () => {
    it("builds the nested analytics field expression", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ analytics: { data_points: [] } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[4].handler;
      await handler({
        waba_id: "111",
        metric_type: "MESSAGING",
        start: "2026-07-01",
        end: "2026-07-20",
        granularity: "DAY",
        dimensions: undefined,
        phone_numbers: undefined,
      });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      const fields = url.searchParams.get("fields")!;
      expect(fields).toMatch(/^analytics\.start\(\d+\)\.end\(\d+\)\.granularity\(DAY\)$/);
    });

    it("maps granularity vocabulary for conversation analytics", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ conversation_analytics: { data: [] } }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[4].handler;
      await handler({
        waba_id: "111",
        metric_type: "CONVERSATION",
        start: "2026-07-01",
        end: "2026-07-20",
        granularity: "DAY",
        dimensions: ["CONVERSATION_CATEGORY", "COUNTRY"],
        phone_numbers: undefined,
      });

      const fields = new URL(fetchMock.mock.calls[0][0] as string).searchParams.get("fields")!;
      expect(fields).toContain("conversation_analytics.start(");
      expect(fields).toContain(".granularity(DAILY)");
      expect(fields).toContain('.dimensions(["CONVERSATION_CATEGORY","COUNTRY"])');
    });

    it("rejects malformed dimension tokens", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const handler = server._registeredTools[4].handler;
      await expect(
        handler({
          waba_id: "111",
          metric_type: "PRICING",
          start: "2026-07-01",
          end: "2026-07-20",
          granularity: "DAY",
          dimensions: ["COUNTRY).evil("],
          phone_numbers: undefined,
        }),
      ).rejects.toThrow(/Invalid dimension/);
    });
  });

  describe("whatsapp_get_template_analytics handler", () => {
    it("passes start/end/template_ids with DAILY granularity", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTemplateTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[5].handler;
      await handler({
        waba_id: "111",
        start: "2026-07-01",
        end: "2026-07-20",
        template_ids: ["801", "802"],
        metric_types: ["SENT", "READ"],
      });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/template_analytics");
      expect(url.searchParams.get("granularity")).toBe("DAILY");
      expect(url.searchParams.get("template_ids")).toBe('["801","802"]');
      expect(url.searchParams.get("metric_types")).toBe('["SENT","READ"]');
      expect(url.searchParams.get("start")).toMatch(/^\d+$/);
    });
  });
});
