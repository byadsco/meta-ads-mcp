import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerBillingTools } from "../../src/tools/billing.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerBillingTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 4 tools", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_billing_info",
      "ads_get_spend_limit",
      "ads_update_spend_cap",
      "ads_get_invoices",
    ]);
  });

  describe("ads_get_billing_info handler", () => {
    it("returns formatted billing info", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const mockBilling = {
        id: "act_123",
        name: "Test Account",
        currency: "USD",
        timezone_name: "America/New_York",
        spend_cap: "100000",
        amount_spent: "50000",
        balance: "20000",
        business_name: "Test Business",
        account_status: 1,
        funding_source_details: {
          id: "funding_1",
          display_string: "Visa ending in 4242",
          type: 1,
        },
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockBilling)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Test Account");
      expect(result.content[0].text).toContain("Test Business");
      expect(result.content[0].text).toContain("ACTIVE");
      expect(result.content[0].text).toContain("500.00 USD");
      expect(result.content[0].text).toContain("Visa ending in 4242");
    });
  });

  describe("ads_get_spend_limit handler", () => {
    it("returns spend limit info with usage percentage", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const mockSpend = {
        id: "act_123",
        name: "Test Account",
        currency: "USD",
        spend_cap: "100000",
        amount_spent: "75000",
        balance: "25000",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockSpend)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("750.00 USD");
      expect(result.content[0].text).toContain("75.0%");
    });
  });

  describe("ads_update_spend_cap handler", () => {
    it("updates spend cap and returns confirmation", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({ account_id: "123", spend_cap: 100000 }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Spend cap updated");
      expect(result.content[0].text).toContain("1000.00 USD");
    });

    it("handles removing spend cap (setting to 0)", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({ account_id: "123", spend_cap: 0 }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("No limit (removed)");
    });
  });

  describe("ads_get_invoices handler", () => {
    it("lists invoices for a business_id with their PDF links", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: [
            {
              id: "9001",
              invoice_id: "INV-2026-001",
              billing_period: "2026-05",
              amount_due: "1500.00",
              currency: "USD",
              payment_status: "PAID",
              due_date: "2026-06-15",
              download_uri: "https://business.facebook.com/invoice/INV-2026-001.pdf",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ business_id: "100" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0] as string).toContain("/100/business_invoices");
      expect(result.content[0].text).toContain("INV-2026-001");
      expect(result.content[0].text).toContain("PAID");
      expect(result.content[0].text).toContain("https://business.facebook.com/invoice/INV-2026-001.pdf");
    });

    it("resolves the business from account_id before fetching invoices", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse({ business: { id: "100", name: "Biz" } }))
        .mockResolvedValueOnce(
          mockFetchResponse({
            data: [{ id: "9001", invoice_id: "INV-1", payment_status: "NOT_PAID" }],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ account_id: "123" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0] as string).toContain("/act_123");
      expect(fetchMock.mock.calls[1][0] as string).toContain("/100/business_invoices");
      expect(result.content[0].text).toContain("INV-1");
    });

    it("returns an explanatory message when there are no invoices", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[3].handler;
      const result = (await handler({ business_id: "100" })) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("No invoices found");
      expect(result.content[0].text).toContain("FINANCE");
    });

    it("throws when neither business_id nor account_id is provided", async () => {
      const server = createMockMcpServer();
      registerBillingTools(server as never);

      const handler = server._registeredTools[3].handler;
      await expect(handler({})).rejects.toThrow(/business_id or account_id/);
    });
  });
});
