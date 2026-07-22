import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerWhatsAppTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 8 tools", () => {
    const server = createMockMcpServer();
    registerWhatsAppTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(8);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerWhatsAppTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "whatsapp_get_business_accounts",
      "whatsapp_get_phone_numbers",
      "whatsapp_register_phone",
      "whatsapp_deregister_phone",
      "whatsapp_request_verification_code",
      "whatsapp_verify_code",
      "whatsapp_get_business_profile",
      "whatsapp_update_business_profile",
    ]);
  });

  describe("whatsapp_get_business_accounts handler", () => {
    it("lists owned and client WABAs for an explicit business", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          mockFetchResponse({ data: [{ id: "111", name: "Main WABA", account_review_status: "APPROVED" }] }),
        )
        .mockResolvedValueOnce(
          mockFetchResponse({ data: [{ id: "222", name: "Client WABA" }] }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        business_id: "9001",
        waba_id: undefined,
        include_client_wabas: true,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 2 WhatsApp Business Account(s)");
      expect(result.content[0].text).toContain("Main WABA");
      expect(result.content[0].text).toContain("Client WABA");

      const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(firstUrl.pathname).toContain("/9001/owned_whatsapp_business_accounts");
      const secondUrl = new URL(fetchMock.mock.calls[1][0] as string);
      expect(secondUrl.pathname).toContain("/9001/client_whatsapp_business_accounts");
    });

    it("discovers businesses via /me/businesses when no business_id given", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ data: [{ id: "9001", name: "ByAds" }] }))
        .mockResolvedValueOnce(mockFetchResponse({ data: [{ id: "111", name: "Main WABA" }] }))
        .mockResolvedValueOnce(mockFetchResponse({ data: [] }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        business_id: undefined,
        waba_id: undefined,
        include_client_wabas: true,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      const firstUrl = new URL(fetchMock.mock.calls[0][0] as string);
      expect(firstUrl.pathname).toContain("/me/businesses");
      expect(result.content[0].text).toContain("Main WABA");
      expect(result.content[0].text).toContain("owned by ByAds");
    });

    it("fetches single WABA details when waba_id is given", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({ id: "111", name: "Main WABA", account_review_status: "APPROVED" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        business_id: undefined,
        waba_id: "111",
        include_client_wabas: true,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("WABA: Main WABA");
      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.searchParams.get("fields")).toContain("health_status");
    });
  });

  describe("whatsapp_get_phone_numbers handler", () => {
    it("lists phone numbers on a WABA", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: [
              {
                id: "333",
                display_phone_number: "+1 650 555 1111",
                verified_name: "ByAds",
                code_verification_status: "VERIFIED",
                quality_rating: "GREEN",
              },
            ],
          }),
        ),
      );

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        waba_id: "111",
        phone_number_id: undefined,
        fields: undefined,
        limit: 25,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 phone number(s)");
      expect(result.content[0].text).toContain("+1 650 555 1111");
      expect(result.content[0].text).toContain("GREEN");
    });

    it("requires waba_id or phone_number_id", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const handler = server._registeredTools[1].handler;
      await expect(
        handler({ waba_id: undefined, phone_number_id: undefined, fields: undefined, limit: 25 }),
      ).rejects.toThrow(/waba_id/);
    });
  });

  describe("whatsapp_register_phone handler", () => {
    it("posts JSON with messaging_product and pin", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        phone_number_id: "333",
        pin: "123456",
        data_localization_region: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("registered");

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toContain("/333/register");
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: "whatsapp",
        pin: "123456",
      });
    });
  });

  describe("whatsapp_get_business_profile handler", () => {
    it("unwraps the profile from the data array", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: [{ about: "We do ads", vertical: "PROF_SERVICES", websites: ["https://byads.co"] }],
          }),
        ),
      );

      const handler = server._registeredTools[6].handler;
      const result = await handler({ phone_number_id: "333" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("About: We do ads");
      expect(result.content[0].text).toContain("https://byads.co");
    });
  });

  describe("whatsapp_update_business_profile handler", () => {
    it("rejects when no profile fields are provided", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const handler = server._registeredTools[7].handler;
      await expect(
        handler({
          phone_number_id: "333",
          about: undefined,
          address: undefined,
          description: undefined,
          email: undefined,
          websites: undefined,
          vertical: undefined,
        }),
      ).rejects.toThrow(/at least one/i);
    });

    it("posts only the provided fields plus messaging_product", async () => {
      const server = createMockMcpServer();
      registerWhatsAppTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse({ success: true }));
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[7].handler;
      await handler({
        phone_number_id: "333",
        about: "New about",
        address: undefined,
        description: undefined,
        email: undefined,
        websites: undefined,
        vertical: undefined,
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        messaging_product: "whatsapp",
        about: "New about",
      });
    });
  });
});
