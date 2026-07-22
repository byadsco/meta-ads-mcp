import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWhatsAppFlowTools } from "../../src/tools/whatsapp-flows.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerWhatsAppFlowTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 6 tools", () => {
    const server = createMockMcpServer();
    registerWhatsAppFlowTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerWhatsAppFlowTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "whatsapp_get_flows",
      "whatsapp_create_flow",
      "whatsapp_update_flow",
      "whatsapp_publish_flow",
      "whatsapp_deprecate_flow",
      "whatsapp_delete_flow",
    ]);
  });

  describe("whatsapp_get_flows handler", () => {
    it("lists flows and flags validation errors", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: [
              { id: "901", name: "Lead Gen", status: "DRAFT", validation_errors: [{ error: "MISSING_ACTION" }] },
              { id: "902", name: "Survey", status: "PUBLISHED", validation_errors: [] },
            ],
          }),
        ),
      );

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        waba_id: "111",
        flow_id: undefined,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 2 flow(s)");
      expect(result.content[0].text).toContain("Lead Gen — DRAFT");
      expect(result.content[0].text).toContain("has validation errors");
    });
  });

  describe("whatsapp_create_flow handler", () => {
    it("posts JSON with name and categories and surfaces validation errors", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ id: "901", validation_errors: [{ error: "MISSING_ACTION" }] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        waba_id: "111",
        name: "Lead Gen",
        categories: ["LEAD_GENERATION"],
        flow_json: '{"version":"7.0","screens":[]}',
        clone_flow_id: undefined,
        endpoint_uri: undefined,
        publish: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain('Flow "Lead Gen" created');
      expect(result.content[0].text).toContain("Validation errors");

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/flows");
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.categories).toEqual(["LEAD_GENERATION"]);
      expect(body.flow_json).toBe('{"version":"7.0","screens":[]}');
    });
  });

  describe("whatsapp_update_flow handler", () => {
    it("uploads flow_json as a multipart asset to /assets", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ success: true }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true, validation_errors: [] }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        flow_id: "901",
        name: "Lead Gen v2",
        categories: undefined,
        endpoint_uri: undefined,
        flow_json: '{"version":"7.0","screens":[]}',
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Flow 901 updated");
      expect(result.content[0].text).toContain("flow content replaced");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const metadataUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(metadataUrl.pathname).toMatch(/\/901$/);
      const assetUrl = new URL(fetchMock.mock.calls[1][0] as string);
      expect(assetUrl.pathname).toContain("/901/assets");
      const assetInit = fetchMock.mock.calls[1][1] as RequestInit;
      expect(assetInit.body).toBeInstanceOf(FormData);
      expect((assetInit.body as FormData).get("asset_type")).toBe("FLOW_JSON");
    });

    it("rejects when nothing to update", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      const handler = server._registeredTools[2].handler;
      await expect(
        handler({
          flow_id: "901",
          name: undefined,
          categories: undefined,
          endpoint_uri: undefined,
          flow_json: undefined,
        }),
      ).rejects.toThrow(/at least one/i);
    });
  });

  describe("lifecycle handlers", () => {
    it("publishes a flow via /publish", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = await handler({ flow_id: "901" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Flow 901 published");
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/901/publish");
    });

    it("deletes a flow with DELETE", async () => {
      const server = createMockMcpServer();
      registerWhatsAppFlowTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[5].handler;
      await handler({ flow_id: "901" });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("DELETE");
    });
  });
});
