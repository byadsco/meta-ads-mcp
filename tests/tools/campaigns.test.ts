import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCampaignTools } from "../../src/tools/campaigns.js";
import { metaApiClient } from "../../src/meta/client.js";
import {
  accountCurrency,
  entityAccountCurrency,
  resetAccountCurrencyCacheForTests,
} from "../../src/meta/account-currency.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
  stubWriteAndCurrencyLookup,
  fetchCallSummary,
} from "../setup.js";

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

    it("sends a spend cap and the countries of a special ad category", async () => {
      const params = await createCampaign({ special_ad_categories: ["ONLINE_GAMBLING_AND_GAMING"], special_ad_category_country: ["CO", "MX"], spend_cap: 100000 });

      expect(params.get("spend_cap")).toBe("100000");
      expect(JSON.parse(params.get("special_ad_category_country")!)).toEqual(["CO", "MX"]);
      expect(JSON.parse(params.get("special_ad_categories")!)).toEqual(["ONLINE_GAMBLING_AND_GAMING"]);
    });

    // Measured: an empty list sent as text arrives empty and Meta answers
    // "special_ad_categories is required"; a JSON list, empty or not, is taken.
    it.each([
      ["an empty list", [], []],
      ["NONE", ["NONE"], []],
      ["two categories", ["HOUSING", "EMPLOYMENT"], ["HOUSING", "EMPLOYMENT"]],
      ["NONE next to a real category", ["NONE", "HOUSING"], ["HOUSING"]],
    ])("sends special ad categories as a JSON list Meta accepts: %s", async (_label, categories, sent) => {
      const params = await createCampaign({ special_ad_categories: categories });
      expect(JSON.parse(params.get("special_ad_categories")!)).toEqual(sent);
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

  describe("budget stated in the account currency", () => {
    type TextResult = { content: Array<{ type: string; text: string }> };

    beforeEach(() => {
      metaApiClient.resetForTests();
      resetAccountCurrencyCacheForTests();
    });

    const create = async (extra: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);
      const result = await server._registeredTools[2].handler({
        account_id: "act_123",
        name: "Budgeted",
        objective: "OUTCOME_SALES",
        status: "PAUSED",
        special_ad_categories: ["NONE"],
        buying_type: "AUCTION",
        ...extra,
      }) as TextResult;
      return result.content[0].text;
    };

    const update = async (changes: Record<string, unknown>) => {
      const server = createMockMcpServer();
      registerCampaignTools(server as never);
      const result = await server._registeredTools[3].handler({ campaign_id: "100123", ...changes }) as TextResult;
      return result.content[0].text;
    };

    it("create: a COP account's daily budget is whole pesos", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000200" }, account: { currency: "COP" } });

      const text = await create({ daily_budget: 50000 });

      expect(text).toContain("Campaign created successfully!");
      expect(text.split("\n")).toContain("Daily budget: COP 50,000 (account currency COP)");
    });

    it("create: a USD account's daily budget is hundredths of a dollar", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000201" }, account: { currency: "USD" } });

      const text = await create({ daily_budget: 5000 });

      expect(text.split("\n")).toContain("Daily budget: USD 50.00 (account currency USD)");
    });

    it("create: a lifetime budget gets its own line", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000202" }, account: { currency: "COP" } });

      const text = await create({ lifetime_budget: 900000 });

      expect(text.split("\n")).toContain("Lifetime budget: COP 900,000 (account currency COP)");
      expect(text).not.toContain("Daily budget");
    });

    // Measured on a USD account: 5000 is refused as under the $100 minimum and
    // 10000 reads back as 10000, so the campaign cap is in the minor unit,
    // unlike the account cap.
    it("create: a campaign spend cap gets its own line, in the budgets' minor unit", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000204" }, account: { currency: "USD" } });

      const text = await create({ spend_cap: 10000 });

      expect(text.split("\n")).toContain("Spend cap: USD 100.00 (account currency USD)");
    });

    it("create: still succeeds when the currency lookup throws, and says only what it knows", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000203" } });

      const text = await create({ daily_budget: 50000 });

      expect(text).toContain("Campaign created successfully!");
      expect(text).toContain("ID: 1000203");
      expect(text.split("\n")).toContain(
        "Daily budget: 50000 in the account currency's minor unit (currency not confirmed; check ads_get_account_info)",
      );
      expect(text).not.toContain("500.00");
    });

    it("create: writes once, and reads the currency only after the write", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000204" }, account: { currency: "COP" } });

      await create({ daily_budget: 50000 });

      expect(fetchCallSummary()).toEqual(["POST /act_123/campaigns", "GET /act_123"]);
    });

    it("create: sends the budget to Meta exactly as given, whatever the currency", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000205" }, account: { currency: "COP" } });

      await create({ daily_budget: 50000 });

      const params = new URLSearchParams(vi.mocked(fetch).mock.calls[0][1]?.body as string);
      expect(params.get("daily_budget")).toBe("50000");
    });

    it("create: does not read the currency when the call fails", async () => {
      stubWriteAndCurrencyLookup({
        write: { error: { code: 100, type: "OAuthException", message: "Invalid parameter" } },
        account: { currency: "COP" },
      });

      await expect(create({ daily_budget: 50000 })).rejects.toThrow();
      expect(fetchCallSummary()).toEqual(["POST /act_123/campaigns"]);
    });

    it("create: does not read the currency for a campaign without a budget", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000206" }, account: { currency: "COP" } });

      const text = await create({});

      expect(fetchCallSummary()).toEqual(["POST /act_123/campaigns"]);
      expect(text).not.toContain("budget:");
    });

    it("create: reads the currency once for several campaigns in the same account", async () => {
      stubWriteAndCurrencyLookup({ write: { id: "1000207" }, account: { currency: "COP" } });

      await create({ daily_budget: 50000 });
      const text = await create({ daily_budget: 80000 });

      expect(text.split("\n")).toContain("Daily budget: COP 80,000 (account currency COP)");
      expect(fetchCallSummary().filter((call) => call.startsWith("GET"))).toEqual(["GET /act_123"]);
    });

    // The audit's scenario: on the shared client, three lookups answered with
    // 80004 opened the account's circuit for 900 s and the fourth write was
    // refused before it was sent.
    it("create: lookups that Meta throttles do not stop the writes that follow", async () => {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? mockFetchResponse({ id: "1000300" })
          : mockFetchResponse({ error: { code: 80004, type: "OAuthException", message: "Too many calls to this ad-account." } }, { status: 400 })));

      for (let i = 0; i < 3; i++) await create({ daily_budget: 50000 });
      const text = await create({ daily_budget: 50000 });

      expect(fetchCallSummary().filter((call) => call === "POST /act_123/campaigns")).toHaveLength(4);
      expect(text).toContain("Campaign created successfully!");
      expect(metaApiClient.getUsageSnapshot().circuits).toEqual([]);
    });

    // The audit's scenario: a usage header on the lookup's answer made the
    // rate limiter hold the next write for 120 s.
    it("create: a usage header on the lookup's answer does not delay the write that follows", async () => {
      vi.useFakeTimers();
      try {
        const postedAt: number[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            postedAt.push(Date.now());
            return mockFetchResponse({ id: "1000301" });
          }
          return mockFetchResponse({ currency: "COP" }, {
            headers: { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 99, reset_time_duration: 120 }) },
          });
        }));
        const started = Date.now();

        const first = create({ daily_budget: 50000 });
        await vi.advanceTimersByTimeAsync(0);
        expect((await first).split("\n")).toContain("Daily budget: COP 50,000 (account currency COP)");
        const second = create({ daily_budget: 60000 });
        await vi.advanceTimersByTimeAsync(0);

        expect(postedAt).toEqual([started, started]);
        expect((await second).split("\n")).toContain("Daily budget: COP 60,000 (account currency COP)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("update: lookups that Meta throttles do not stop the writes that follow", async () => {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? mockFetchResponse({ success: true })
          : mockFetchResponse({ error: { code: 80004, type: "OAuthException", message: "Too many calls to this ad-account." } }, { status: 400 })));

      for (let i = 0; i < 3; i++) await update({ daily_budget: 75000 });
      await update({ daily_budget: 75000 });

      expect(fetchCallSummary().filter((call) => call === "POST /100123")).toHaveLength(4);
      expect(metaApiClient.getUsageSnapshot().circuits).toEqual([]);
    });

    // API-key and stdio mode keep the active token in the process, where
    // ads_set_active_token can change it between two awaits of another call.
    describe("when the process-wide active token changes during the lookup", () => {
      const refused = () => mockFetchResponse(
        { error: { code: 100, type: "OAuthException", message: "Unsupported get request." } },
        { status: 400 },
      );

      /** `onRead(n)` runs after the n-th time anything asks for the active token. */
      const activeToken = (initial: string) => {
        const state = { active: initial, reads: 0, onRead: (_reads: number): void => undefined };
        vi.spyOn(tokenManager, "getActiveToken").mockImplementation(() => {
          state.reads += 1;
          const value = state.active;
          state.onRead(state.reads);
          return value;
        });
        return state;
      };

      /** Every request so far as "METHOD /path token". */
      const requests = () => vi.mocked(fetch).mock.calls.map(([url, init]) => {
        const parsed = new URL(String(url));
        return `${init?.method ?? "GET"} ${parsed.pathname.replace(/^\/v[\d.]+/, "")} ${parsed.searchParams.get("access_token")}`;
      });

      /** Answers each GET according to the token it carries; every POST succeeds. */
      const stubByToken = (answers: Record<string, (path: string) => Response>, onGet?: (path: string) => void) => {
        vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
          if (init?.method === "POST") return mockFetchResponse({ id: "1000400", success: true });
          const parsed = new URL(url);
          const path = parsed.pathname.replace(/^\/v[\d.]+/, "");
          onGet?.(path);
          return answers[parsed.searchParams.get("access_token") ?? ""]?.(path) ?? refused();
        }));
      };

      // The write reads the token first; the lookup's own read is the second.
      // Switching in a microtask after it lands in the lookup's first await.
      const switchDuringTheLookup = (state: ReturnType<typeof activeToken>, to: string) => {
        state.onRead = (reads) => {
          if (reads === 2) queueMicrotask(() => { state.active = to; });
        };
      };

      it("create: the GET carries the token the lookup started with, and its answer is kept for that token only", async () => {
        const state = activeToken("token-A");
        switchDuringTheLookup(state, "token-B");
        stubByToken({ "token-A": () => mockFetchResponse({ currency: "COP" }) });

        const text = await create({ daily_budget: 50000 });

        expect(state.active).toBe("token-B");
        expect(requests()).toEqual(["POST /act_123/campaigns token-A", "GET /act_123 token-A"]);
        expect(text.split("\n")).toContain("Daily budget: COP 50,000 (account currency COP)");

        await expect(accountCurrency("act_123")).resolves.toBeUndefined();
        expect(requests().at(-1)).toBe("GET /act_123 token-B");

        state.active = "token-A";
        await expect(accountCurrency("act_123")).resolves.toBe("COP");
        expect(requests()).toHaveLength(3);
      });

      // The audit's scenario: A's own GET would fail, B's succeeds.
      it("create: back on the first token, nothing obtained with the second answers for it", async () => {
        const state = activeToken("token-A");
        switchDuringTheLookup(state, "token-B");
        stubByToken({ "token-B": () => mockFetchResponse({ currency: "COP" }) });

        const text = await create({ daily_budget: 50000 });

        expect(state.active).toBe("token-B");
        expect(requests()).toEqual(["POST /act_123/campaigns token-A", "GET /act_123 token-A"]);
        expect(text.split("\n")).toContain(
          "Daily budget: 50000 in the account currency's minor unit (currency not confirmed; check ads_get_account_info)",
        );

        state.active = "token-A";
        await expect(accountCurrency("act_123")).resolves.toBeUndefined();
        expect(requests().at(-1)).toBe("GET /act_123 token-A");
        expect(requests()).toHaveLength(3);
      });

      it("update: both reads of the lookup carry one token, even if it changes between them", async () => {
        const state = activeToken("token-A");
        stubByToken(
          {
            "token-A": (path) => mockFetchResponse(path === "/100123" ? { account_id: "123" } : { currency: "COP" }),
            "token-B": (path) => mockFetchResponse(path === "/100123" ? { account_id: "999" } : { currency: "USD" }),
          },
          (path) => {
            if (path === "/100123") state.active = "token-B";
          },
        );

        const text = await update({ daily_budget: 75000 });

        expect(state.active).toBe("token-B");
        expect(requests()).toEqual(["POST /100123 token-A", "GET /100123 token-A", "GET /act_123 token-A"]);
        expect(text.split("\n")).toContain("Daily budget: COP 75,000 (account currency COP)");

        await expect(entityAccountCurrency("100123")).resolves.toBe("USD");
        expect(requests().slice(3)).toEqual(["GET /100123 token-B", "GET /act_999 token-B"]);

        state.active = "token-A";
        await expect(entityAccountCurrency("100123")).resolves.toBe("COP");
        expect(requests()).toHaveLength(5);
      });
    });

    it("update: finds the campaign's account and states the new budget in its currency", async () => {
      stubWriteAndCurrencyLookup({
        write: { success: true },
        entity: { account_id: "123", id: "100123" },
        account: { currency: "COP" },
      });

      const text = await update({ daily_budget: 75000 });

      expect(text).toContain("Campaign 100123 updated successfully.");
      expect(text.split("\n")).toContain("Daily budget: COP 75,000 (account currency COP)");
      expect(fetchCallSummary()).toEqual(["POST /100123", "GET /100123", "GET /act_123"]);
    });

    it("update: still succeeds when the currency lookup throws", async () => {
      stubWriteAndCurrencyLookup({ write: { success: true } });

      const text = await update({ lifetime_budget: 900000 });

      expect(text).toContain("Campaign 100123 updated successfully.");
      expect(text.split("\n")).toContain(
        "Lifetime budget: 900000 in the account currency's minor unit (currency not confirmed; check ads_get_account_info)",
      );
    });

    it("update: does not read anything when no budget changes", async () => {
      stubWriteAndCurrencyLookup({ write: { success: true }, account: { currency: "COP" } });

      await update({ status: "PAUSED" });

      expect(fetchCallSummary()).toEqual(["POST /100123"]);
    });
  });
});
