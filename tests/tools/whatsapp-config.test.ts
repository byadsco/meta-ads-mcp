import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWhatsAppConfigTools } from "../../src/tools/whatsapp-config.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerWhatsAppConfigTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 7 tools", () => {
    const server = createMockMcpServer();
    registerWhatsAppConfigTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(7);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerWhatsAppConfigTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "whatsapp_get_qr_codes",
      "whatsapp_create_qr_code",
      "whatsapp_update_qr_code",
      "whatsapp_delete_qr_code",
      "whatsapp_get_webhook_subscriptions",
      "whatsapp_subscribe_webhook",
      "whatsapp_unsubscribe_webhook",
    ]);
  });

  describe("whatsapp_get_qr_codes handler", () => {
    it("lists QR codes with deep links", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: [
              {
                code: "ABC123XYZ",
                prefilled_message: "Hola, quiero info",
                deep_link_url: "https://wa.me/message/ABC123XYZ",
              },
            ],
          }),
        ),
      );

      const handler = server._registeredTools[0].handler;
      const result = await handler({ phone_number_id: "333", code: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Found 1 QR code(s)");
      expect(result.content[0].text).toContain("https://wa.me/message/ABC123XYZ");
    });

    it("unwraps a bare single-code object when fetching by code", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            code: "ABC123XYZ",
            prefilled_message: "Hola",
            deep_link_url: "https://wa.me/message/ABC123XYZ",
          }),
        ),
      );

      const handler = server._registeredTools[0].handler;
      const result = await handler({ phone_number_id: "333", code: "ABC123XYZ" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Found 1 QR code(s)");
      expect(result.content[0].text).toContain("ABC123XYZ");
    });

    it("rejects malformed QR code ids", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const handler = server._registeredTools[0].handler;
      await expect(
        handler({ phone_number_id: "333", code: "../evil" }),
      ).rejects.toThrow(/Invalid QR code id/);
    });
  });

  describe("whatsapp_create_qr_code handler", () => {
    it("posts the prefilled message and returns the deep link", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          code: "ABC123XYZ",
          prefilled_message: "Hola",
          deep_link_url: "https://wa.me/message/ABC123XYZ",
          qr_image_url: "https://example.com/qr.svg",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        phone_number_id: "333",
        prefilled_message: "Hola",
        generate_qr_image: "SVG",
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("QR code created");
      expect(result.content[0].text).toContain("https://example.com/qr.svg");

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/333/message_qrdls");
      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ prefilled_message: "Hola", generate_qr_image: "SVG" });
    });
  });

  describe("whatsapp_delete_qr_code handler", () => {
    it("deletes by code in the path", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      await handler({ phone_number_id: "333", code: "ABC123XYZ" });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/333/message_qrdls/ABC123XYZ");
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    });
  });

  describe("webhook subscription handlers", () => {
    it("lists subscribed apps", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: [{ whatsapp_business_api_data: { id: "555", name: "ByAds App" } }],
          }),
        ),
      );

      const handler = server._registeredTools[4].handler;
      const result = await handler({ waba_id: "111" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("1 app(s) subscribed");
      expect(result.content[0].text).toContain("ByAds App");
    });

    it("subscribe rejects override_callback_uri without verify_token", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const handler = server._registeredTools[5].handler;
      await expect(
        handler({
          waba_id: "111",
          override_callback_uri: "https://example.com/webhook",
          verify_token: undefined,
        }),
      ).rejects.toThrow(/together/);
    });

    it("subscribes the app with a POST to subscribed_apps", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[5].handler;
      const result = await handler({
        waba_id: "111",
        override_callback_uri: undefined,
        verify_token: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("App subscribed");
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/subscribed_apps");
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    });

    it("unsubscribes with DELETE", async () => {
      const server = createMockMcpServer();
      registerWhatsAppConfigTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[6].handler;
      await handler({ waba_id: "111" });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/111/subscribed_apps");
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    });
  });
});
