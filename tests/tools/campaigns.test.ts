import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCampaignTools } from "../../src/tools/campaigns.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerCampaignTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 5 tools", () => {
    const server = createMockMcpServer();
    registerCampaignTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerCampaignTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_campaigns",
      "ads_get_campaign_details",
      "ads_create_campaign",
      "ads_update_campaign",
      "ads_delete_campaign",
    ]);
  });

  describe("ads_get_campaigns handler", () => {
    it("returns campaign list", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      const mockData = {
        data: [
          {
            id: "1001",
            name: "Campaign 1",
            status: "ACTIVE",
            objective: "OUTCOME_TRAFFIC",
            daily_budget: "5000",
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        account_id: "act_123",
        limit: 25,
        status_filter: undefined,
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Found 1 campaign(s)");
      expect(result.content[0].text).toContain("Campaign 1");
    });

    it("includes status filter in API request", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[0].handler;
      await handler({
        account_id: "act_123",
        limit: 25,
        status_filter: ["ACTIVE", "PAUSED"],
        fields: undefined,
      });

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      const filtering = url.searchParams.get("filtering");
      expect(filtering).toBeTruthy();
      const parsed = JSON.parse(filtering!);
      expect(parsed[0].field).toBe("effective_status");
      expect(parsed[0].value).toEqual(["ACTIVE", "PAUSED"]);
    });
  });

  describe("ads_create_campaign handler", () => {
    it("creates a campaign and returns ID", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "1000123" })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "123",
        name: "New Campaign",
        objective: "OUTCOME_TRAFFIC",
        status: "PAUSED",
        special_ad_categories: ["NONE"],
        daily_budget: 5000,
        lifetime_budget: undefined,
        bid_strategy: undefined,
        buying_type: "AUCTION",
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Campaign created successfully");
      expect(result.content[0].text).toContain("1000123");
    });

    // Marketing API v24.0+ rejects a campaign without a campaign budget unless
    // is_adset_budget_sharing_enabled is sent explicitly.
    const createCampaign = async (extra: Record<string, unknown> = {}) => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "1000124" })));

      await server._registeredTools[2].handler({
        account_id: "123",
        name: "Sales Campaign",
        objective: "OUTCOME_SALES",
        status: "PAUSED",
        special_ad_categories: ["NONE"],
        buying_type: "AUCTION",
        ...extra,
      });

      return new URLSearchParams(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    };

    it("turns ad set budget sharing off when the budget lives on the ad sets and the caller does not choose", async () => {
      const params = await createCampaign();
      expect(params.get("is_adset_budget_sharing_enabled")).toBe("false");
    });

    it("sends the caller's ad set budget sharing choice", async () => {
      const params = await createCampaign({ is_adset_budget_sharing_enabled: true });
      expect(params.get("is_adset_budget_sharing_enabled")).toBe("true");
    });

    it.each([
      ["daily_budget", 5000],
      ["lifetime_budget", 900000],
    ])("does not send ad set budget sharing when the campaign has a %s", async (field, amount) => {
      const params = await createCampaign({ [field]: amount });
      expect(params.get(field)).toBe(String(amount));
      expect(params.has("is_adset_budget_sharing_enabled")).toBe(false);
    });

    it.each([
      ["daily_budget", 5000],
      ["lifetime_budget", 900000],
    ])("refuses ad set budget sharing on a campaign with a %s, without calling Meta", async (field, amount) => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "1000125" })));

      await expect(server._registeredTools[2].handler({
        account_id: "123",
        name: "CBO Campaign",
        objective: "OUTCOME_SALES",
        status: "PAUSED",
        special_ad_categories: ["NONE"],
        buying_type: "AUCTION",
        is_adset_budget_sharing_enabled: true,
        [field]: amount,
      })).rejects.toThrow(/is_adset_budget_sharing_enabled/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("accepts every special ad category Meta currently documents", () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);
      const shape = server._registeredTools[2].schema as {
        special_ad_categories: { safeParse: (v: unknown) => { success: boolean } };
      };

      expect(shape.special_ad_categories.safeParse(["FINANCIAL_PRODUCTS_SERVICES"]).success).toBe(true);
      expect(shape.special_ad_categories.safeParse(["ONLINE_GAMBLING_AND_GAMING"]).success).toBe(true);
      expect(shape.special_ad_categories.safeParse(["LOTTERY"]).success).toBe(false);
    });
  });

  describe("ads_update_campaign handler", () => {
    it("updates a campaign", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        campaign_id: "100123",
        name: "Updated Name",
        status: "PAUSED",
        daily_budget: undefined,
        lifetime_budget: undefined,
        bid_strategy: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("updated successfully");
      const params = new URLSearchParams(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(params.has("is_adset_budget_sharing_enabled")).toBe(false);
    });

    it("can switch ad set budget sharing off on an existing campaign", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      await server._registeredTools[3].handler({
        campaign_id: "100123",
        is_adset_budget_sharing_enabled: false,
      });

      const params = new URLSearchParams(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(params.get("is_adset_budget_sharing_enabled")).toBe("false");
    });
  });

  describe("ads_delete_campaign handler", () => {
    it("soft-deletes a campaign", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[4].handler;
      const result = await handler({ campaign_id: "100123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("deleted");
      expect(result.content[0].text).toContain("100123");

      // Verify status is set to DELETED in the form body
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.body).toContain("status=DELETED");
    });
  });
});
