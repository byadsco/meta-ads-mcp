import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAccountTools } from "../../src/tools/accounts.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerAccountTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 3 tools", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(3);
  });

  it("registers meta_ads_get_ad_accounts tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[0].name).toBe("meta_ads_get_ad_accounts");
  });

  it("registers meta_ads_get_account_info tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[1].name).toBe("meta_ads_get_account_info");
  });

  it("registers meta_ads_get_pages tool", () => {
    const server = createMockMcpServer();
    registerAccountTools(server as never);
    expect(server._registeredTools[2].name).toBe("meta_ads_get_pages");
  });

  describe("meta_ads_get_ad_accounts handler", () => {
    it("returns account data formatted correctly", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockData = {
        data: [
          {
            id: "act_123",
            account_id: "123",
            name: "Test Account",
            account_status: 1,
            currency: "USD",
            amount_spent: "5000",
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ user_id: "me", limit: 100, fields: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content).toHaveLength(2);
      expect(result.content[0].text).toContain("Found 1 ad account(s)");
      expect(result.content[0].text).toContain("Test Account");
      expect(result.content[0].text).toContain("ACTIVE");
    });

    it("handles empty account list", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({ user_id: "me", limit: 100, fields: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("No ad accounts found");
    });
  });

  describe("meta_ads_get_account_info handler", () => {
    it("normalizes account ID and returns details", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockAccount = {
        id: "act_123",
        account_id: "123",
        name: "My Account",
        account_status: 1,
        currency: "USD",
        timezone_name: "America/New_York",
        amount_spent: "15000",
        balance: "5000",
        spend_cap: "100000",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockAccount)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({ account_id: "123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("My Account");
      expect(result.content[0].text).toContain("ACTIVE");
      expect(result.content[0].text).toContain("America/New_York");

      // Verify the URL uses normalized account ID
      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("act_123");
    });
  });

  describe("meta_ads_get_pages handler", () => {
    it("returns pages for user when no account_id", async () => {
      const server = createMockMcpServer();
      registerAccountTools(server as never);

      const mockData = {
        data: [
          { id: "page_1", name: "My Page", category: "Business" },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[2].handler;
      const result = await handler({ account_id: undefined }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("Found 1 page(s)");
      expect(result.content[0].text).toContain("My Page");

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("/me/accounts");
    });
  });
});
