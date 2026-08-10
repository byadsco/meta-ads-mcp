import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerAdsLibraryTools } from "../../src/tools/ads-library.js";
import {
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
} from "../../src/store/apify-token-repo.js";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { createMockMcpServer, mockFetchResponse } from "../setup.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, so this fixture never trips the secret scanner.
const TOKEN = "apify_api_testfixture";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function setup() {
  const server = createMockMcpServer();
  registerAdsLibraryTools(server as never);
  const byName = (name: string) => {
    const tool = server._registeredTools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.handler as (args: Record<string, unknown>) => Promise<ToolResult>;
  };
  return { server, byName };
}

const SCRAPE_DEFAULTS = {
  query: undefined,
  url: undefined,
  country: "ALL",
  active_status: "active",
  ad_type: "all",
  search_type: "keyword_unordered",
  period: "",
  sort_by: "impressions_desc",
  count: 100,
  scrape_ad_details: false,
};

describe("ads_library_* tools", () => {
  let repo: InMemoryApifyTokenRepo;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "c".repeat(64);
    resetKeyCacheForTests();
    repo = new InMemoryApifyTokenRepo();
    configureApifyTokenRepoForTests(repo);
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(undefined);
  });

  describe("registration", () => {
    it("registers exactly 8 tools", () => {
      const { server } = setup();
      expect(server.registerTool).toHaveBeenCalledTimes(8);
    });

    it("registers the expected names", () => {
      const { server } = setup();
      expect(server._registeredTools.map((t) => t.name)).toEqual([
        "ads_library_register_apify_token",
        "ads_library_get_apify_token_status",
        "ads_library_delete_apify_token",
        "ads_library_scrape",
        "ads_library_get_run_status",
        "ads_library_get_results",
        "ads_library_abort_run",
        "ads_library_list_runs",
      ]);
    });

    it("warns on every non-read tool", () => {
      const { server } = setup();
      for (const tool of server._registeredTools) {
        if (tool.annotations?.readOnlyHint !== true) {
          expect(tool.description).toContain("⚠️");
        }
      }
    });
  });

  describe("ads_library_register_apify_token", () => {
    it("validates against Apify then stores the token encrypted", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockFetchResponse({ data: { id: "u1", username: "byads" } }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await setup().byName("ads_library_register_apify_token")({
        apify_token: TOKEN,
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.apify.com/v2/users/me");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

      expect(result.isError).toBeUndefined();
      expect(await repo.getDecryptedToken("_local")).toBe(TOKEN);
    });

    it("never echoes the raw token back to the client", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(mockFetchResponse({ data: { id: "u1", username: "byads" } })),
      );

      const result = await setup().byName("ads_library_register_apify_token")({
        apify_token: TOKEN,
      });

      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(TOKEN);
      // Not even a suffix of the secret body leaks back to the MCP client.
      expect(rendered).not.toContain(TOKEN.slice(-4));
      expect(rendered).toContain("byads");
      expect(rendered).toContain("apify_api_***");
    });

    it("does not store the token when validation fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({ error: { type: "token-not-found" } }, { status: 401 }),
        ),
      );

      const result = await setup().byName("ads_library_register_apify_token")({
        apify_token: "apify_api_bogus",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NOT stored");
      expect(await repo.getDecryptedToken("_local")).toBeNull();
    });
  });

  describe("ads_library_get_apify_token_status", () => {
    it("reports the encrypted per-user source once registered", async () => {
      await repo.saveToken("_local", TOKEN, { id: "u1", username: "byads" });

      const result = await setup().byName("ads_library_get_apify_token_status")({
        verify: false,
      });

      expect(result.content[0].text).toContain("encrypted_user_storage");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("reports the env fallback when nothing is stored in single-tenant mode", async () => {
      const result = await setup().byName("ads_library_get_apify_token_status")({
        verify: false,
      });
      expect(result.content[0].text).toContain("env");
    });

    it("does not advertise the env fallback in multi-tenant mode, where it is unreachable", async () => {
      const savedId = process.env.META_APP_ID;
      const savedSecret = process.env.META_APP_SECRET;
      process.env.META_APP_ID = "1234567890";
      process.env.META_APP_SECRET = "f".repeat(32);

      try {
        // No OAuth identity + multi-tenant → the resolver refuses outright, so
        // the status tool must not claim an env token has us covered.
        await expect(
          setup().byName("ads_library_get_apify_token_status")({ verify: false }),
        ).rejects.toThrow(/authenticated user in multi-tenant mode/);
      } finally {
        if (savedId === undefined) delete process.env.META_APP_ID;
        else process.env.META_APP_ID = savedId;
        if (savedSecret === undefined) delete process.env.META_APP_SECRET;
        else process.env.META_APP_SECRET = savedSecret;
      }
    });

    it("reports none when there is no token anywhere", async () => {
      delete process.env.APIFY_TOKEN;
      const result = await setup().byName("ads_library_get_apify_token_status")({
        verify: false,
      });
      expect(result.content[0].text).toContain("No Apify token available");
    });
  });

  describe("ads_library_delete_apify_token", () => {
    it("deletes a stored token", async () => {
      await repo.saveToken("_local", TOKEN, null);

      const result = await setup().byName("ads_library_delete_apify_token")({});

      expect(result.isError).toBeUndefined();
      expect(await repo.getDecryptedToken("_local")).toBeNull();
      expect(result.content[0].text).toContain("environment fallback is still active");
    });

    it("errors when there is nothing to delete", async () => {
      const result = await setup().byName("ads_library_delete_apify_token")({});
      expect(result.isError).toBe(true);
    });
  });

  describe("ads_library_scrape", () => {
    function stubRunStart() {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: {
            id: "run123abc",
            actId: "act1",
            status: "READY",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: null,
            defaultDatasetId: "ds123abc",
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("builds an Ad Library search URL from keyword params", async () => {
      const fetchMock = stubRunStart();

      await setup().byName("ads_library_scrape")({
        ...SCRAPE_DEFAULTS,
        query: "nike",
        country: "CO",
        count: 20,
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(
        "/v2/acts/curious_coder~facebook-ads-library-scraper/runs",
      );

      const body = JSON.parse(init.body as string) as { urls: Array<{ url: string }>; count: number };
      const target = new URL(body.urls[0].url);
      expect(target.origin + target.pathname).toBe("https://www.facebook.com/ads/library/");
      expect(target.searchParams.get("q")).toBe("nike");
      expect(target.searchParams.get("country")).toBe("CO");
      expect(target.searchParams.get("active_status")).toBe("active");
      expect(target.searchParams.get("search_type")).toBe("keyword_unordered");
      expect(body.count).toBe(20);
    });

    it("sends the actor's dotted page-filter keys", async () => {
      const fetchMock = stubRunStart();

      await setup().byName("ads_library_scrape")({
        ...SCRAPE_DEFAULTS,
        url: "https://www.facebook.com/ZapierApp",
        country: "US",
        period: "last7d",
        sort_by: "most_recent",
        active_status: "all",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body["scrapePageAds.activeStatus"]).toBe("all");
      expect(body["scrapePageAds.countryCode"]).toBe("US");
      expect(body["scrapePageAds.period"]).toBe("last7d");
      expect(body["scrapePageAds.sortBy"]).toBe("most_recent");
      expect(body.urls).toEqual([{ url: "https://www.facebook.com/ZapierApp" }]);
    });

    it("sends a server-side spend cap derived from count", async () => {
      const fetchMock = stubRunStart();

      await setup().byName("ads_library_scrape")({
        ...SCRAPE_DEFAULTS,
        query: "nike",
        count: 1000,
      });

      const [url] = fetchMock.mock.calls[0] as [string];
      // 1000 ads * $0.00075 + $0.00005 start → ceil to $0.76
      expect(new URL(url).searchParams.get("maxTotalChargeUsd")).toBe("0.76");
    });

    it("reports the run and dataset ids", async () => {
      stubRunStart();

      const result = await setup().byName("ads_library_scrape")({
        ...SCRAPE_DEFAULTS,
        query: "nike",
      });

      expect(result.content[0].text).toContain("run123abc");
      expect(result.content[0].text).toContain("ds123abc");
      expect(JSON.parse(result.content[1].text)).toMatchObject({
        runId: "run123abc",
        datasetId: "ds123abc",
      });
    });

    it.each([
      ["http://www.facebook.com/ads/library/", "plain http"],
      ["https://evil.com/ads/library/", "non-facebook host"],
      ["https://facebook.com.evil.com/x", "suffix lookalike host"],
      ["https://notfacebook.com/x", "prefix lookalike host"],
      ["https://www.facebook.com@evil.com/x", "userinfo host confusion"],
      ["https://user:pass@www.facebook.com/x", "embedded credentials"],
      ["https://www.facebook.com:8443/x", "non-default port"],
      ["https://www.facebook.com/l.php?u=https://evil.com", "outbound redirector"],
      ["https://www.facebook.com/%6c.php?u=https://evil.com", "percent-encoded redirector"],
      ["https://www.facebook.com//l.php?u=https://evil.com", "doubled-slash redirector"],
      ["https://www.facebook.com/l.php/?u=https://evil.com", "trailing-slash redirector"],
      ["https://www.facebook.com/AWAY.PHP?u=https://evil.com", "uppercase redirector"],
      ["not a url", "unparseable"],
    ])("rejects %s (%s)", async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS, url }),
      ).rejects.toThrow(McpError);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects passing both query and url", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({
          ...SCRAPE_DEFAULTS,
          query: "nike",
          url: "https://www.facebook.com/Nike",
        }),
      ).rejects.toThrow(/exactly one/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects passing neither query nor url", async () => {
      vi.stubGlobal("fetch", vi.fn());

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS }),
      ).rejects.toThrow(/exactly one/i);
    });

    it("rejects a whitespace-only query instead of starting a billable open search", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS, query: "   " }),
      ).rejects.toThrow(/exactly one/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("ads_library_get_run_status", () => {
    it("summarises a succeeded run and points at the dataset", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: {
              id: "run123abc",
              actId: "act1",
              status: "SUCCEEDED",
              startedAt: "2026-08-09T00:00:00.000Z",
              finishedAt: "2026-08-09T00:01:00.000Z",
              defaultDatasetId: "ds123abc",
              usageTotalUsd: 0.0153,
              stats: { runTimeSecs: 42.4 },
            },
          }),
        ),
      );

      const result = await setup().byName("ads_library_get_run_status")({ run_id: "run123abc" });

      expect(result.content[0].text).toContain("SUCCEEDED");
      expect(result.content[0].text).toContain("$0.0153");
      expect(result.content[0].text).toContain("ads_library_get_results");
    });

    it("reports charged ads from the event count when Apify has not settled the amount", async () => {
      // Real behaviour observed against Apify: a run that has just flipped to
      // SUCCEEDED still reports usageTotalUsd: 0, which reads as "free".
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: {
              id: "run123abc",
              status: "SUCCEEDED",
              defaultDatasetId: "ds123abc",
              usageTotalUsd: 0,
              chargedEventCounts: { "apify-default-dataset-item": 20 },
            },
          }),
        ),
      );

      const result = await setup().byName("ads_library_get_run_status")({ run_id: "run123abc" });

      expect(result.content[0].text).toContain("20 ad(s) charged");
      expect(result.content[0].text).toContain("≈$0.0150");
      expect(result.content[0].text).toContain("not settled");
      expect(result.content[0].text).not.toContain("$0.0000");
    });

    it("prefers the settled per-event amount once Apify reports it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          mockFetchResponse({
            data: {
              id: "run123abc",
              status: "SUCCEEDED",
              defaultDatasetId: "ds123abc",
              usageTotalUsd: 0.015,
              chargedEventCounts: { "apify-default-dataset-item": 20 },
              eventUsage: { "apify-default-dataset-item": { eventTotalUsd: 0.015 } },
            },
          }),
        ),
      );

      const result = await setup().byName("ads_library_get_run_status")({ run_id: "run123abc" });

      expect(result.content[0].text).toContain("20 ad(s) charged, $0.0150");
      expect(result.content[0].text).not.toContain("not settled");
    });

    it("rejects a malformed run id before calling Apify", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_get_run_status")({ run_id: "../../v2/users/me" }),
      ).rejects.toThrow(McpError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("ads_library_get_results", () => {
    const rawAd = {
      ad_archive_id: "123",
      page_id: "456",
      page_name: "Nike",
      is_active: true,
      // The real actor wraps body in { text } while leaving title a plain string.
      snapshot: { body: { text: "Just do it" }, title: "Nike", cta_text: "Shop now" },
      internal_noise: "x".repeat(100),
    };

    it("requests the dataset with pagination params", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockFetchResponse([rawAd]));
      vi.stubGlobal("fetch", fetchMock);

      await setup().byName("ads_library_get_results")({
        dataset_id: "ds123abc",
        offset: 20,
        limit: 10,
        raw: false,
      });

      const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
      expect(url.pathname).toBe("/v2/datasets/ds123abc/items");
      expect(url.searchParams.get("offset")).toBe("20");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("clean")).toBe("true");
    });

    it("returns a compact projection by default", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([rawAd])));

      const result = await setup().byName("ads_library_get_results")({
        dataset_id: "ds123abc",
        offset: 0,
        limit: 50,
        raw: false,
      });

      const ads = JSON.parse(result.content[1].text) as Array<Record<string, unknown>>;
      expect(ads[0].page_name).toBe("Nike");
      expect(ads[0].body).toBe("Just do it");
      expect(ads[0]).not.toHaveProperty("internal_noise");
    });

    it("returns untouched records when raw=true", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([rawAd])));

      const result = await setup().byName("ads_library_get_results")({
        dataset_id: "ds123abc",
        offset: 0,
        limit: 50,
        raw: true,
      });

      const ads = JSON.parse(result.content[1].text) as Array<Record<string, unknown>>;
      expect(ads[0]).toHaveProperty("internal_noise");
    });

    it("hints at the next page when the page is full", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([rawAd, rawAd])));

      const result = await setup().byName("ads_library_get_results")({
        dataset_id: "ds123abc",
        offset: 0,
        limit: 2,
        raw: false,
      });

      expect(result.content[0].text).toContain("offset=2");
    });

    it("handles an empty dataset without throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([])));

      const result = await setup().byName("ads_library_get_results")({
        dataset_id: "ds123abc",
        offset: 0,
        limit: 50,
        raw: false,
      });

      expect(result.content[0].text).toContain("No ads at offset 0");
      expect(JSON.parse(result.content[1].text)).toEqual([]);
    });
  });

  describe("ads_library_abort_run", () => {
    it("posts to the abort endpoint and reports the new status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: { id: "run123abc", status: "ABORTED", defaultDatasetId: "ds123abc" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await setup().byName("ads_library_abort_run")({ run_id: "run123abc" });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.apify.com/v2/actor-runs/run123abc/abort");
      expect(init.method).toBe("POST");
      expect(result.content[0].text).toContain("ABORTED");
    });
  });

  describe("ads_library_list_runs", () => {
    it("lists runs newest first", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockFetchResponse({
          data: {
            items: [
              { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", usageTotalUsd: 0.02 },
              { id: "run2", status: "ABORTED", defaultDatasetId: "ds2" },
            ],
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await setup().byName("ads_library_list_runs")({ limit: 10 });

      const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
      expect(url.searchParams.get("desc")).toBe("true");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(result.content[0].text).toContain("Found 2 run(s)");
      expect(result.content[0].text).toContain("run1");
      // The list endpoint omits chargedEventCounts, so no bogus "? ad(s)".
      expect(result.content[0].text).toContain("$0.0200 charged");
      expect(result.content[0].text).not.toContain("?");
    });

    it("handles an account with no runs", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: { items: [] } })));

      const result = await setup().byName("ads_library_list_runs")({ limit: 10 });
      expect(result.content[0].text).toContain("No Ad Library scrape runs");
    });
  });
});
