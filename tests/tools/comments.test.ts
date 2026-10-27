import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCommentTools } from "../../src/tools/comments.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse, fetchCallSummary } from "../setup.js";

function getComments() {
  const server = createMockMcpServer();
  registerCommentTools(server as never);
  return server._registeredTools.find((t) => t.name === "ads_get_ad_comments")!.handler;
}

describe("ads_get_ad_comments", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves an ad's post through its creative, the node that has the post ID", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "3001", creative: { id: "4001", effective_object_story_id: "6001_777" } }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [] })));

    await getComments()({ ad_id: "3001", limit: 50, filter: "toplevel" });

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /6001_777/comments"]);
    const adRead = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(adRead.searchParams.get("fields")).toBe("creative{effective_object_story_id}");
  });

  it("says so when the ad has no post yet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "3001", creative: { id: "4001" } })));

    const result = await getComments()({ ad_id: "3001", limit: 50, filter: "toplevel" }) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toMatch(/no associated post/);
  });
});
