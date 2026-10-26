import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAdContentTools } from "../../src/tools/ad-content.js";
import { metaApiClient } from "../../src/meta/client.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse, fetchCallSummary } from "../setup.js";

type ToolResult = { content: Array<{ text: string }> };

const MULTI_TEXT_CREATIVE = {
  id: "4001",
  name: "Multi",
  effective_object_story_id: "6001_777",
  effective_instagram_media_id: "17900000000000001",
  object_story_spec: {
    page_id: "6001",
    instagram_user_id: "17841400000000001",
    link_data: { link: "https://example.com/", image_hash: "h1", call_to_action: { type: "SIGN_UP" } },
  },
  asset_feed_spec: {
    bodies: [{ text: "Uno" }, { text: "Dos" }],
    titles: [{ text: "T1" }],
    optimization_type: "DEGREES_OF_FREEDOM",
  },
};

function tool() {
  const server = createMockMcpServer();
  registerAdContentTools(server as never);
  return server._registeredTools[0];
}

function bodyOf(index: number): URLSearchParams {
  return new URLSearchParams(String(vi.mocked(fetch).mock.calls[index][1]?.body ?? ""));
}

describe("ads_update_ad_content", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers one write tool that warns in its description", () => {
    const server = createMockMcpServer();
    registerAdContentTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    const registered = server._registeredTools[0];
    expect(registered.name).toBe("ads_update_ad_content");
    expect(registered.description).toContain("⚠️");
    expect(registered.annotations?.readOnlyHint).not.toBe(true);
  });

  it("previews by default: plans the change and reads the engagement at stake, without writing", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "3001", account_id: "123", creative: { id: "4001" } }))
      .mockResolvedValueOnce(mockFetchResponse(MULTI_TEXT_CREATIVE))
      .mockResolvedValueOnce(mockFetchResponse({ reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 4 } }, shares: { count: 2 } }))
      .mockResolvedValueOnce(mockFetchResponse({ like_count: 7, comments_count: 1 })));

    const result = await tool().handler({ ad_ids: ["3001"], primary_texts: { remove: ["Dos"], add: ["Tres"] } }) as ToolResult;

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /4001", "GET /6001_777", "GET /17900000000000001"]);
    expect(result.content[0].text).toMatch(/^Dry run/);
    expect(result.content[0].text).toContain("keeps its Facebook post");
    expect(result.content[0].text).toContain("Facebook 12 reactions, 4 comments, 2 shares");
    const report = JSON.parse(result.content[1].text);
    expect(report.plans[0]).toMatchObject({
      route: "same_post",
      before: { primary: ["Uno", "Dos"] },
      after: { primary: ["Uno", "Tres"] },
      social_proof: { facebook: "kept", instagram: "reset" },
    });
  });

  it("applies a primary-text change on the same post and reports the previous creative for undo", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "3001", account_id: "123", creative: { id: "4001" } }))
      .mockResolvedValueOnce(mockFetchResponse(MULTI_TEXT_CREATIVE))
      .mockResolvedValueOnce(mockFetchResponse({ id: "4100" }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true })));

    const result = await tool().handler({
      ad_ids: ["3001"],
      primary_texts: { add: ["Tres"] },
      dry_run: false,
    }) as ToolResult;

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /4001", "POST /act_123/adcreatives", "POST /3001"]);
    const creative = bodyOf(2);
    expect(creative.get("object_story_id")).toBe("6001_777");
    expect(creative.get("object_story_spec")).toBeNull();
    expect(JSON.parse(creative.get("asset_feed_spec")!).bodies).toEqual([{ text: "Uno" }, { text: "Dos" }, { text: "Tres" }]);
    expect(bodyOf(3).get("creative")).toBe(JSON.stringify({ creative_id: "4100" }));
    expect(result.content[0].text).toContain("Ad 3001: previous creative 4001, new 4100");
  });

  it("changes nothing when any ad's plan fails, so a batch never half-applies", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "3001", account_id: "123", creative: { id: "4001" } }))
      .mockResolvedValueOnce(mockFetchResponse(MULTI_TEXT_CREATIVE)));

    const result = await tool().handler({
      ad_ids: ["3001"],
      primary_texts: { remove: ["No existe"] },
      dry_run: false,
    }) as ToolResult;

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /4001"]);
    expect(result.content[0].text).toMatch(/^Nothing was changed/);
    expect(result.content[0].text).toContain('Cannot remove primary text "No existe"');
  });

  it("leaves an ad alone when the change needs a new post and allow_new_post is off", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "3001", account_id: "123", creative: { id: "4001" } }))
      .mockResolvedValueOnce(mockFetchResponse(MULTI_TEXT_CREATIVE)));

    const result = await tool().handler({ ad_ids: ["3001"], headlines: { set: ["Nuevo"] }, dry_run: false }) as ToolResult;

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /4001"]);
    expect(result.content[0].text).toMatch(/not changed — .*allow_new_post: true/);
  });

  it("refuses a private image URL before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(tool().handler({ ad_ids: ["3001"], image_url: "https://127.0.0.1/a.jpg", allow_new_post: true }))
      .rejects.toThrow(/Refusing to forward image_url/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
