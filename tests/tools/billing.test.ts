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

  it("registers exactly 3 tools", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(3);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerBillingTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "meta_ads_get_billing_info",
      "meta_ads_get_spend_limit",
      "meta_ads_update_spend_cap",
    ]);
  });

  describe("meta_ads_get_billing_info handler", () => {
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

  describe("meta_ads_get_spend_limit handler", () => {
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

  describe("meta_ads_update_spend_cap handler", () => {
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
});
