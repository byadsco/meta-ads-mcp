import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaApiClient } from "../../src/meta/client.js";
import { resetAccountCurrencyCacheForTests } from "../../src/meta/account-currency.js";
import { registerEntityTools } from "../../src/tools/entities.js";
import {
  cleanupTestToken,
  createMockMcpServer,
  fetchCallSummary,
  mockFetchResponse,
  setupTestToken,
  stubWriteAndCurrencyLookup,
} from "../setup.js";

describe("ads_update_entity: budget stated in the account currency", () => {
  type TextResult = { content: Array<{ type: string; text: string }> };

  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  const update = async (entity_type: string, updates: Record<string, unknown>) => {
    const server = createMockMcpServer();
    registerEntityTools(server as never);
    const tool = server._registeredTools.find((t) => t.name === "ads_update_entity");
    const result = await tool!.handler({ entity_type, entity_id: "2001", updates }) as TextResult;
    return result.content[0].text;
  };

  it("states a new ad set budget in the currency of the ad set's account", async () => {
    stubWriteAndCurrencyLookup({
      write: { success: true },
      entity: { account_id: "123", id: "2001" },
      account: { currency: "COP" },
    });

    const text = await update("ad_set", { daily_budget: 50000 });

    expect(text).toContain("ad_set 2001 updated.");
    expect(text.split("\n")).toContain("Daily budget: COP 50,000 (account currency COP)");
    expect(fetchCallSummary()).toEqual(["POST /2001", "GET /2001", "GET /act_123"]);
  });

  it("reads a budget passed as a string of digits the same way", async () => {
    stubWriteAndCurrencyLookup({
      write: { success: true },
      entity: { account_id: "123" },
      account: { currency: "USD" },
    });

    const text = await update("campaign", { lifetime_budget: "250000" });

    expect(text.split("\n")).toContain("Lifetime budget: USD 2,500.00 (account currency USD)");
  });

  it("still succeeds when the currency lookup throws", async () => {
    stubWriteAndCurrencyLookup({ write: { success: true } });

    const text = await update("ad_set", { daily_budget: 50000 });

    expect(text).toContain("ad_set 2001 updated.");
    expect(text.split("\n")).toContain(
      "Daily budget: 50000 in the account currency's minor unit (currency not confirmed; check ads_get_account_info)",
    );
  });

  it("does not read anything when the update carries no amount", async () => {
    stubWriteAndCurrencyLookup({ write: { success: true }, account: { currency: "COP" } });

    await update("ad", { name: "Renamed", status: "PAUSED" });

    expect(fetchCallSummary()).toEqual(["POST /2001"]);
  });

  // The generic updater cannot tell a campaign's cap (minor unit) from an ad
  // account's (whole currency) when it is handed an act_ id, so it states
  // neither: a wrong line would be off by a factor of 100.
  it("never states a spend_cap, whose unit depends on what the id turns out to be", async () => {
    stubWriteAndCurrencyLookup({ write: { success: true }, entity: { account_id: "123" }, account: { currency: "USD" } });

    const text = await update("campaign", { spend_cap: 10000 });

    expect(text).not.toMatch(/^Spend cap/m);
    expect(text).not.toContain("USD 100.00");
  });
});

describe("ads_get_ad_entities: filtering", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  const list = async (args: Record<string, unknown>) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));
    const server = createMockMcpServer();
    registerEntityTools(server as never);
    const tool = server._registeredTools.find((t) => t.name === "ads_get_ad_entities")!;
    await tool.handler({ entity_type: "campaign", parent_id: "123", limit: 25, ...args });
    const filtering = new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("filtering");
    return filtering === null ? null : JSON.parse(filtering);
  };

  it("sends the caller's filters to Meta", async () => {
    const filters = [
      { field: "name", operator: "CONTAIN", value: "Summer" },
      { field: "created_time", operator: "GREATER_THAN", value: 1793600000 },
    ];
    expect(await list({ filtering: filters })).toEqual(filters);
  });

  it("keeps status_filter, alongside the caller's filters", async () => {
    expect(await list({ status_filter: ["ACTIVE"], filtering: [{ field: "objective", operator: "IN", value: ["OUTCOME_SALES"] }] })).toEqual([
      { field: "effective_status", operator: "IN", value: ["ACTIVE"] },
      { field: "objective", operator: "IN", value: ["OUTCOME_SALES"] },
    ]);
  });

  it("sends no filtering when none is asked for", async () => {
    expect(await list({})).toBeNull();
  });
});
