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
    expect(server.tool).toHaveBeenCalledTimes(5);
  });

  it("registers tools with correct names", () => {
    const server = createMockMcpServer();
    registerCampaignTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "meta_ads_get_campaigns",
      "meta_ads_get_campaign_details",
      "meta_ads_create_campaign",
      "meta_ads_update_campaign",
      "meta_ads_delete_campaign",
    ]);
  });

  describe("meta_ads_get_campaigns handler", () => {
    it("returns campaign list", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      const mockData = {
        data: [
          {
            id: "camp_1",
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

  describe("meta_ads_create_campaign handler", () => {
    it("creates a campaign and returns ID", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "camp_new_123" })));

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
      expect(result.content[0].text).toContain("camp_new_123");
    });
  });

  describe("meta_ads_update_campaign handler", () => {
    it("updates a campaign", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[3].handler;
      const result = await handler({
        campaign_id: "camp_123",
        name: "Updated Name",
        status: "PAUSED",
        daily_budget: undefined,
        lifetime_budget: undefined,
        bid_strategy: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("updated successfully");
    });
  });

  describe("meta_ads_delete_campaign handler", () => {
    it("soft-deletes a campaign", async () => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[4].handler;
      const result = await handler({ campaign_id: "camp_123" }) as {
        content: Array<{ type: string; text: string }>;
      };

      expect(result.content[0].text).toContain("deleted");
      expect(result.content[0].text).toContain("camp_123");

      // Verify status is set to DELETED in the form body
      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.body).toContain("status=DELETED");
    });
  });
});
