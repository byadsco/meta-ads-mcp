import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaApiClient } from "../../src/meta/client.js";
import { resetAccountCurrencyCacheForTests } from "../../src/meta/account-currency.js";
import { registerEntityTools } from "../../src/tools/entities.js";
import {
  cleanupTestToken,
  createMockMcpServer,
  fetchCallSummary,
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
