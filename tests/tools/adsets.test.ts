import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaApiClient } from "../../src/meta/client.js";
import { registerAdSetTools } from "../../src/tools/adsets.js";
import { resetCloneBundleStoreForTests } from "../../src/store/clone-bundle-store.js";
import {
  cleanupTestToken,
  createMockMcpServer,
  mockFetchResponse,
  setupTestToken,
} from "../setup.js";

describe("registerAdSetTools", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetCloneBundleStoreForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    metaApiClient.resetForTests();
    resetCloneBundleStoreForTests();
    vi.restoreAllMocks();
  });

  it("registers exactly 6 tools", () => {
    const server = createMockMcpServer();
    registerAdSetTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerAdSetTools(server as never);

    const names = server._registeredTools.map((tool) => tool.name);
    expect(names).toEqual([
      "ads_get_ad_sets",
      "ads_get_ad_set_details",
      "ads_clone_ad_set_bundle",
      "ads_create_ad_set",
      "ads_update_ad_set",
      "ads_delete_ad_set",
    ]);
  });

  describe("ads_get_ad_set_details handler", () => {
    it("forces identity fields and never renders undefined with partial field requests", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "2001",
        name: "Honduras - Mujeres",
        campaign_id: "1001",
        status: "PAUSED",
        effective_status: "PAUSED",
        promoted_object: { pixel_id: "px_1" },
      })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        ad_set_id: "2001",
        fields: ["promoted_object"],
      }) as { content: Array<{ type: string; text: string }> };

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      const fields = url.searchParams.get("fields")?.split(",") ?? [];

      expect(fields).toEqual(expect.arrayContaining([
        "id",
        "name",
        "campaign_id",
        "status",
        "effective_status",
        "promoted_object",
      ]));
      expect(result.content[0].text).not.toContain("undefined");
      expect(result.content[0].text).toContain("Optimization: N/A");
      expect(result.content[0].text).toContain("Targeting: N/A");
    });
  });

  describe("ads_clone_ad_set_bundle handler", () => {
    // NOTE: these are unit tests with a mocked fetch. They assert request SHAPE
    // and control flow, NOT that Meta accepts the fields (the effective_link_url
    // #100 bug slipped past mocks for exactly this reason). The /copies semantics
    // and status_option enum must be confirmed against the live API.

    const sourceAdSet = (overrides: Record<string, unknown> = {}) => ({
      id: "2099",
      name: "Source",
      campaign_id: "1001",
      status: "ACTIVE",
      effective_status: "ACTIVE",
      daily_budget: "500",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["CL"] } },
      destination_type: "WEBSITE",
      ...overrides,
    });

    const oneAd = (creativeId = "4001") => ({
      data: [{
        id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
        status: "ACTIVE", effective_status: "ACTIVE", creative: { id: creativeId },
        created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
      }],
    });

    it("dry-run plans a native copy per ad without mutating (no creative read without an override)", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet({ name: "Honduras - Mujeres" })))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Honduras - Mujeres__flyer_1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-03-01T00:00:00-0500", updated_time: "2026-03-01T00:00:00-0500",
          }],
        })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Chile - Mujeres", geo_override: { countries: ["CL"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: true,
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        dry_run: boolean;
        new_ad_set: { name: string; planned?: boolean };
        created_creatives: unknown[];
        created_ads: Array<{ name: string; planned?: boolean }>;
      };

      expect(payload.dry_run).toBe(true);
      expect(payload.new_ad_set.name).toBe("Chile - Mujeres");
      expect(payload.new_ad_set.planned).toBe(true);
      expect(payload.created_ads).toHaveLength(1);
      expect(payload.created_ads[0]?.name).toBe("Chile - Mujeres__flyer_1");
      expect(payload.created_ads[0]?.planned).toBe(true);
      // No override → no creative read, no separately planned creative.
      expect(payload.created_creatives).toHaveLength(0);

      const methods = vi.mocked(fetch).mock.calls.map((call) => call[1]?.method ?? "GET");
      expect(methods).toEqual(["GET", "GET"]);
    });

    it("dry-run reads the creative and plans a swap when an override is present", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet({ name: "Honduras - Mujeres" })))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Honduras - Mujeres__flyer_1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-03-01T00:00:00-0500", updated_time: "2026-03-01T00:00:00-0500",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "Creative HN",
          object_story_spec: { page_id: "6001", link_data: { link: "https://ugc.byads.co/", image_hash: "h1" } },
        })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Chile - Mujeres", geo_override: { countries: ["CL"] }, status: "PAUSED" },
        creative_overrides: [{ source_ad_id: "3001", headline: "Headline Chile", description: "Desc Chile" }],
        dry_run: true,
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        created_creatives: Array<{ planned?: boolean }>;
        created_ads: unknown[];
      };
      expect(payload.created_ads).toHaveLength(1);
      expect(payload.created_creatives).toHaveLength(1);
      expect(payload.created_creatives[0]?.planned).toBe(true);

      const methods = vi.mocked(fetch).mock.calls.map((call) => call[1]?.method ?? "GET");
      expect(methods).toEqual(["GET", "GET", "GET"]);
    });

    it("copies each ad natively into the new ad set, forcing PAUSED", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))            // POST ad set
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" })) // POST /3001/copies
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));        // POST rename

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-copy-1",
      }) as { content: Array<{ type: string; text: string }> };

      const calls = vi.mocked(fetch).mock.calls;
      // Call 2 = POST /act_123/adsets, Call 3 = POST /3001/copies.
      const copyCall = calls[3];
      expect(copyCall[1]?.method).toBe("POST");
      expect(new URL(copyCall[0] as string).pathname).toContain("/3001/copies");
      const copyParams = new URLSearchParams(copyCall[1]?.body as string);
      expect(copyParams.get("adset_id")).toBe("20001");
      expect(copyParams.get("status_option")).toBe("PAUSED");
      expect(JSON.parse(copyParams.get("rename_options") ?? "{}")).toEqual({ rename_strategy: "NO_RENAME" });

      // Rename to the source→target name transform.
      const renameCall = calls[4];
      expect(new URL(renameCall[0] as string).pathname).toContain("/30001");
      expect(new URLSearchParams(renameCall[1]?.body as string).get("name")).toBe("Target__a1");

      // No creative reconstruction — Meta duplicates it server-side.
      const adcreativePosts = calls.filter((c) => new URL(c[0] as string).pathname.endsWith("/adcreatives"));
      expect(adcreativePosts).toHaveLength(0);

      const payload = JSON.parse(result.content[1].text) as { created_ads: Array<{ id?: string }> };
      expect(payload.created_ads[0]?.id).toBe("30001");
    });

    it("copies a dynamic (asset_feed_spec) ad natively instead of skipping it", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      // No override → the creative is never read; native copy handles the
      // dynamic creative server-side regardless of its shape.
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-dyn-1",
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        created_ads: Array<{ id?: string }>;
        skipped: unknown[];
      };
      expect(payload.created_ads).toHaveLength(1);
      expect(payload.created_ads[0]?.id).toBe("30001");
      expect(payload.skipped).toHaveLength(0);
    });

    it("copies but reports (does not silently change) an override on a dynamic creative", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          asset_feed_spec: { bodies: [{ text: "x" }] },
          object_story_spec: { page_id: "6001", link_data: { link: "https://x.com/" } },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [{ source_ad_id: "3001", headline: "New" }],
        dry_run: false,
        idempotency_key: "k-dynover-1",
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        created_ads: Array<{ id?: string }>;
        created_creatives: unknown[];
        warnings: string[];
      };
      // Ad still copied...
      expect(payload.created_ads[0]?.id).toBe("30001");
      // ...but no creative was swapped and a warning was raised.
      expect(payload.created_creatives).toHaveLength(0);
      expect(payload.warnings.some((w) => /asset_feed_spec/.test(w))).toBe(true);

      // No adcreatives POST — we never patch a dynamic creative.
      const adcreativePosts = vi.mocked(fetch).mock.calls.filter(
        (c) => new URL(c[0] as string).pathname.endsWith("/adcreatives"),
      );
      expect(adcreativePosts).toHaveLength(0);
    });

    it("applies an override by swapping a patched creative onto the copied ad", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          object_story_spec: {
            page_id: "6001",
            link_data: {
              link: "https://x.com/", image_hash: "h1",
              name: "Old headline", message: "Old message", description: "Old desc",
              call_to_action: { type: "LEARN_MORE" },
            },
          },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))           // POST ad set
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" })) // POST /3001/copies
        .mockResolvedValueOnce(mockFetchResponse({ success: true }))         // POST rename
        .mockResolvedValueOnce(mockFetchResponse({ id: "41001" }))           // POST /adcreatives
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));       // POST swap

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [{
          source_ad_id: "3001", headline: "New headline", description: "New desc", call_to_action_type: "SHOP_NOW",
        }],
        dry_run: false,
        idempotency_key: "k-swap-1",
      }) as { content: Array<{ type: string; text: string }> };

      const calls = vi.mocked(fetch).mock.calls;
      const creativeCall = calls.find((c) => new URL(c[0] as string).pathname.endsWith("/adcreatives"))!;
      const oss = JSON.parse(
        new URLSearchParams(creativeCall[1]?.body as string).get("object_story_spec") ?? "{}",
      ) as { link_data?: Record<string, unknown> };
      // Patched fields applied, real media reused.
      expect(oss.link_data?.name).toBe("New headline");
      expect(oss.link_data?.description).toBe("New desc");
      expect(oss.link_data?.image_hash).toBe("h1");
      expect((oss.link_data?.call_to_action as Record<string, unknown>)?.type).toBe("SHOP_NOW");

      // Swap onto the copied ad (the POST to /30001 after the creative was made).
      const creativeIdx = calls.indexOf(creativeCall);
      const swapCall = calls.find((c, i) => i > creativeIdx && new URL(c[0] as string).pathname.endsWith("/30001"))!;
      expect(JSON.parse(new URLSearchParams(swapCall[1]?.body as string).get("creative") ?? "{}")).toEqual({ creative_id: "41001" });

      const payload = JSON.parse(result.content[1].text) as {
        created_creatives: Array<{ id?: string }>;
        created_ads: Array<{ creative_id?: string }>;
      };
      expect(payload.created_creatives[0]?.id).toBe("41001");
      expect(payload.created_ads[0]?.creative_id).toBe("41001");
    });

    it("skips a single failed ad copy and continues with the rest", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [
            { id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
              status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
              created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000" },
            { id: "3002", name: "Source__a2", adset_id: "2099", campaign_id: "1001",
              status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4002" },
              created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000" },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))           // POST ad set
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" })) // POST /3001/copies OK
        .mockResolvedValueOnce(mockFetchResponse({ success: true }))         // POST rename 30001
        .mockResolvedValueOnce(mockFetchResponse({                           // POST /3002/copies FAILS
          error: { message: "Bad copy", type: "OAuthException", code: 100 },
        })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-skip-1",
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        created_ads: Array<{ id?: string }>;
        skipped: Array<{ source_ad_id?: string; reason: string }>;
        warnings: string[];
      };
      expect(payload.created_ads).toHaveLength(1);
      expect(payload.created_ads[0]?.id).toBe("30001");
      expect(payload.skipped).toHaveLength(1);
      expect(payload.skipped[0]?.source_ad_id).toBe("3002");
      expect(payload.warnings.length).toBeGreaterThan(0);
    });

    it("throws with partial state when every ad copy fails (ad set left empty)", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))   // POST ad set OK
        .mockResolvedValueOnce(mockFetchResponse({                   // POST /3001/copies FAILS
          error: { message: "Bad copy", type: "OAuthException", code: 100 },
        })));

      const handler = server._registeredTools[2].handler;
      await expect(handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-allfail-1",
      })).rejects.toThrow(/partial state.*ad_set=20001.*ads=\[\]/);
    });

    it("throws when the source ad set has no ads to copy (no empty ad set created)", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[2].handler;
      await expect(handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-noads-1",
      })).rejects.toThrow(/no ads to copy/);

      const posts = vi.mocked(fetch).mock.calls.filter((c) => c[1]?.method === "POST");
      expect(posts).toHaveLength(0);
    });

    it("never duplicates destination_type in the source GET fields list", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(sourceAdSet({ name: "X" }))));

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Y", geo_override: { countries: ["CL"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: true,
      }).catch(() => undefined);

      const firstUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      const fields = firstUrl.searchParams.get("fields")?.split(",") ?? [];
      expect(fields.filter((f) => f === "destination_type")).toHaveLength(1);
    });

    it("create: strips read-only targeting fields and replaces geo_locations", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet({
          targeting: {
            geo_locations: { countries: ["CL"], cities: [{ key: "santiago" }] },
            targeting_relaxation_types: { lookalike: 1 },
            targeting_optimization: "expansion_all",
            is_whatsapp_destination_ad: false,
            genders: [2],
          },
          promoted_object: { pixel_id: "px_1" },
        })))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-strip-1",
      });

      // 3rd fetch call = POST /act_123/adsets
      const adsetPost = vi.mocked(fetch).mock.calls[2];
      expect(adsetPost[1]?.method).toBe("POST");
      expect(new URL(adsetPost[0] as string).pathname).toContain("/act_123/adsets");
      const sentTargeting = JSON.parse(
        new URLSearchParams(adsetPost[1]?.body as string).get("targeting") ?? "{}",
      ) as Record<string, unknown>;
      expect(sentTargeting.geo_locations).toEqual({ countries: ["CO"] });
      expect(sentTargeting.genders).toEqual([2]);
      expect(sentTargeting.targeting_relaxation_types).toBeUndefined();
      expect(sentTargeting.targeting_optimization).toBeUndefined();
      expect(sentTargeting.is_whatsapp_destination_ad).toBeUndefined();
    });

    it("user-provided daily_budget wins over source lifetime_budget", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet({
          daily_budget: undefined,
          lifetime_budget: "100000",
          end_time: "2026-12-31T23:59:59-0000",
        })))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED", daily_budget: 500 },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-budget-1",
      });

      const params = new URLSearchParams(vi.mocked(fetch).mock.calls[2][1]?.body as string);
      expect(params.get("daily_budget")).toBe("500");
      expect(params.get("lifetime_budget")).toBeNull();
      expect(params.get("end_time")).toBeNull();
    });

    it("reuses the cached result when called twice with the same idempotency key", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30001" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const input = {
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "clone-key-1",
      };

      const first = await handler(input) as { content: Array<{ type: string; text: string }> };
      const firstPayload = JSON.parse(first.content[1].text) as { new_ad_set: { id?: string }; created_ads: Array<{ id?: string }> };
      expect(firstPayload.new_ad_set.id).toBe("20001");
      expect(firstPayload.created_ads[0]?.id).toBe("30001");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);

      const second = await handler(input) as { content: Array<{ type: string; text: string }> };
      expect(second.content[0].text).toContain("reused cached result");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(5);
    });

    it("reclaims a stale in_progress lock instead of blocking retries forever", async () => {
      const { getCloneBundleStore, STALE_IN_PROGRESS_MS } = await import("../../src/store/clone-bundle-store.js");
      const store = getCloneBundleStore();
      const staleKey = "k-stale-1:act_123:2099:Target";
      await store.claim(staleKey, JSON.stringify({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
      }));
      await store.update(staleKey, { startedAt: Date.now() - STALE_IN_PROGRESS_MS - 1000 });

      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(sourceAdSet()))
        .mockResolvedValueOnce(mockFetchResponse(oneAd()))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20002" }))
        .mockResolvedValueOnce(mockFetchResponse({ copied_ad_id: "30002" }))
        .mockResolvedValueOnce(mockFetchResponse({ success: true })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        dry_run: false,
        idempotency_key: "k-stale-1",
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as { new_ad_set: { id?: string } };
      expect(payload.new_ad_set.id).toBe("20002");
    });
  });

  describe("ads_update_ad_set handler", () => {
    it("issues POST /<ad_set_id> with only the budget field and confirms success", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const tool = server._registeredTools.find((t) => t.name === "ads_update_ad_set");
      expect(tool).toBeDefined();

      const result = await tool!.handler({
        ad_set_id: "2001",
        daily_budget: 5000,
      }) as { content: Array<{ type: string; text: string }> };

      const call = vi.mocked(fetch).mock.calls[0];
      const url = new URL(call[0] as string);
      expect(url.pathname).toMatch(/\/2001$/);
      expect(call[1]?.method).toBe("POST");

      const body = call[1]?.body as string;
      expect(body).toContain("daily_budget=5000");
      expect(body).not.toContain("name=");
      expect(body).not.toContain("status=");
      expect(body).not.toContain("targeting=");

      expect(result.content[0].text).toContain("Ad set 2001 updated successfully");
      expect(result.content[0].text).toContain("daily_budget");
    });
  });
});
