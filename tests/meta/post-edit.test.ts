import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { editPost, findPostUsers, hasServableTemporary, type PostEditInput } from "../../src/meta/post-edit.js";
import { metaApiClient } from "../../src/meta/client.js";
import type { AdCreative } from "../../src/meta/types/index.js";
import { setupTestToken, cleanupTestToken, mockFetchResponse, fetchCallSummary } from "../setup.js";

const LINK = "https://example.com/";
const PAGE_TOKEN = "page-token-never-shown";

const OWN: AdCreative = {
  id: "4001",
  name: "Own",
  effective_object_story_id: "6001_888",
  url_tags: "utm_source=meta",
  adlabels: [{ id: "900", name: "Label" }],
  object_story_spec: {
    page_id: "6001",
    instagram_user_id: "17841400000000001",
    link_data: { link: LINK, image_hash: "h1", message: "Viejo", call_to_action: { type: "LEARN_MORE", value: { link: LINK } } },
  },
};
const REUSE: AdCreative = { id: "4002", name: "Reuse", effective_object_story_id: "6001_888", body: "Viejo" };

function input(overrides: Partial<PostEditInput> = {}): PostEditInput {
  return {
    account_id: "123",
    post: { post_id: "6001_888", page_id: "6001", message: "Nuevo", reuses_post: false },
    users: [
      { ad_id: "3001", status: "ACTIVE", creative_id: "4001" },
      { ad_id: "3002", status: "PAUSED", creative_id: "4002" },
    ],
    creatives: { 4001: OWN, 4002: REUSE },
    ...overrides,
  };
}

// Answers Meta by method and path; each route's replies are used in order and
// the last one repeats. A reply with an error is a 400. With latencyMs, each
// call takes that long on the fake clock.
function stubMeta(routes: Record<string, unknown[]>, clock?: FakeClock, latencyMs = 0): number[] {
  const counts: Record<string, number> = {};
  const times: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (clock && latencyMs) await clock.sleep(latencyMs);
    times.push(clock?.now() ?? 0);
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname.replace(/^\/v[\d.]+/, "")}`;
    const replies = routes[key] ?? [{ success: true }];
    const index = (counts[key] = (counts[key] ?? -1) + 1);
    const reply = replies[Math.min(index, replies.length - 1)];
    return mockFetchResponse(reply, { status: (reply as { error?: unknown }).error ? 400 : 200 });
  }));
  return times;
}

interface FakeClock { now: () => number; sleep: (ms: number) => Promise<void> }
function fakeClock(): FakeClock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const failedEdit = { error: { code: 100, message: "(#100) Failed to edit object" } };
// Not Meta's error format (a proxy, a dropped connection): the write may have
// gone through.
const lostAnswer = { error: "connection reset by a proxy" };
// OWN and REUSE need different copies (OWN carries tracking and labels), so
// two temporary creatives (4900, 4901), then 4950 replacing OWN.
const READY = {
  "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4901" }, { id: "4950" }],
  "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
  "GET /4901": [{ id: "4901", effective_object_story_id: "6001_998" }],
  "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
};
const body = (index: number) => new URLSearchParams(String(vi.mocked(fetch).mock.calls[index][1]?.body ?? ""));
const tokenOf = (index: number) =>
  new URL(String(vi.mocked(fetch).mock.calls[index][0])).searchParams.get("access_token") ?? body(index).get("access_token");
const json = (value: string | null) => (value === null ? null : JSON.parse(value));
const anyStatusWrite = () => vi.mocked(fetch).mock.calls.some((call) => body(vi.mocked(fetch).mock.calls.indexOf(call)).has("status"));

describe("editPost", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("detaches, edits the post and moves every ad back, never touching their status", async () => {
    const clock = fakeClock();
    const times = stubMeta({
      ...READY,
      "POST /6001_888": [failedEdit, { success: true }],
      "DELETE /4900": [{ error: { code: 100, error_subcode: 3858800, message: "In use" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(fetchCallSummary()).toEqual([
      "POST /act_123/adcreatives", "POST /act_123/adcreatives",
      "POST /3001", "POST /3002",
      "GET /4900", "GET /4901",
      "GET /6001", "POST /6001_888", "POST /6001_888",
      "POST /act_123/adcreatives",
      "POST /3001", "POST /3002",
      "DELETE /4900", "DELETE /4901",
    ]);
    // Active ads keep running: each temporary creative is the ad with the new text.
    expect(json(body(0).get("object_story_spec"))).toMatchObject({ link_data: { link: LINK, image_hash: "h1", message: "Nuevo" } });
    expect(body(0).get("url_tags")).toBe("utm_source=meta");
    expect(json(body(1).get("object_story_spec"))).toMatchObject({ link_data: { message: "Nuevo" } });
    expect(body(1).get("url_tags")).toBeNull();
    expect(json(body(2).get("creative"))).toEqual({ creative_id: "4900" });
    expect(json(body(3).get("creative"))).toEqual({ creative_id: "4901" });
    expect(anyStatusWrite()).toBe(false);
    // The edit goes with the Page token, the rest with the person's.
    expect(body(8).get("message")).toBe("Nuevo");
    expect(tokenOf(8)).toBe(PAGE_TOKEN);
    expect(tokenOf(10)).not.toBe(PAGE_TOKEN);
    // The own creative cannot carry the ad again: a creative reusing the post does.
    expect(body(9).get("object_story_id")).toBe("6001_888");
    expect(body(9).get("object_story_spec")).toBeNull();
    expect(body(9).get("instagram_user_id")).toBe("17841400000000001");
    expect(body(9).get("url_tags")).toBe("utm_source=meta");
    expect(json(body(9).get("adlabels"))).toEqual([{ id: "900" }]);
    expect(json(body(10).get("creative"))).toEqual({ creative_id: "4950" });
    expect(json(body(11).get("creative"))).toEqual({ creative_id: "4002" });
    // Meta allows one creative change per ad every 30 seconds.
    expect(times[10] - times[2]).toBeGreaterThanOrEqual(30_000);
    expect(times[11] - times[3]).toBeGreaterThanOrEqual(30_000);

    expect(outcome).toMatchObject({
      edited: true,
      temporary_creatives: ["4900", "4901"],
      temporary_left: ["4900"],
      new_creatives: ["4950"],
      ads: [
        { ad_id: "3001", outcome: "updated", creative_id: "4950", previous_creative_id: "4001", instagram: "reset" },
        { ad_id: "3002", outcome: "updated", creative_id: "4002", previous_creative_id: "4002", instagram: "kept" },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain(PAGE_TOKEN);
  });

  it("puts every ad back on its own creative when Meta keeps turning the edit down", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [failedEdit] }, clock);

    const outcome = await editPost(input(), clock);

    const calls = fetchCallSummary();
    expect(calls.filter((c) => c === "POST /6001_888").length).toBeGreaterThan(3);
    // The two temporary copies, and no replacement.
    expect(calls.filter((c) => c === "POST /act_123/adcreatives")).toHaveLength(2);
    // Meta turned each attempt down, so nothing was written: no need to read the post.
    expect(calls).not.toContain("GET /6001_888");
    expect(outcome).toMatchObject({
      edited: false,
      stage: "edit",
      ads: [
        { ad_id: "3001", outcome: "restored", creative_id: "4001", instagram: "kept" },
        { ad_id: "3002", outcome: "restored", creative_id: "4002", instagram: "kept" },
      ],
    });
    expect(outcome.error).toContain("Failed to edit object");
  });

  it("puts the ads back and never edits when one cannot be moved off the post", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3002": [{ error: { code: 100, message: "Refused" } }],
      "GET /3002": [{ id: "3002", creative: { id: "4002" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    const calls = fetchCallSummary();
    expect(calls).not.toContain("GET /6001");
    expect(calls).not.toContain("POST /6001_888");
    expect(outcome).toMatchObject({
      edited: false,
      stage: "detach",
      ads: [
        { ad_id: "3001", outcome: "restored", creative_id: "4001" },
        { ad_id: "3002", outcome: "unchanged", creative_id: "4002" },
      ],
    });
  });

  it("moves back an ad whose move off the post failed and whose creative could not be read", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3002": [lostAnswer, { success: true }],
      "GET /3002": [{ error: { code: 100, message: "Unavailable" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    // Its state is unknown, so it is pointed back at its own creative too.
    const lastMove = fetchCallSummary().lastIndexOf("POST /3002");
    expect(json(body(lastMove).get("creative"))).toEqual({ creative_id: "4002" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "restored", creative_id: "4002" });
  });

  it("moves back an ad whose move off got no clear answer even when its creative reads back unchanged", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4901" }],
      // Meta's reads can lag: the move may still land after this read.
      "POST /3002": [lostAnswer, { success: true }],
      "GET /3002": [{ id: "3002", creative: { id: "4002" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    const lastMove = fetchCallSummary().lastIndexOf("POST /3002");
    expect(lastMove).toBeGreaterThan(fetchCallSummary().indexOf("POST /3002"));
    expect(json(body(lastMove).get("creative"))).toEqual({ creative_id: "4002" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "restored", creative_id: "4002" });
  });

  it("leaves alone an ad read back on a creative this edit did not set", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3001": [{ error: { code: 100, message: "Refused" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4777" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome).toMatchObject({ edited: false, stage: "detach" });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "unchanged", creative_id: "4777" });
    expect(fetchCallSummary().filter((c) => c === "POST /3001")).toHaveLength(1);
  });

  it("does not edit when the temporary creative turns out to use the same post", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_888" }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(fetchCallSummary()).not.toContain("POST /6001_888");
    expect(outcome).toMatchObject({ edited: false, stage: "wait" });
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["restored", "restored"]);
  });

  it("reports an ad that could not be moved back, on the creative it is read back on", async () => {
    const clock = fakeClock();
    stubMeta({
      ...READY,
      "POST /6001_888": [{ success: true }],
      // moved off, then moving it back is refused
      "POST /3001": [{ success: true }, { error: { code: 100, message: "Refused" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4900" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "left_on_temporary", creative_id: "4900" });
    expect(outcome.ads[0].error).toContain("Refused");
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated" });
  });

  it("calls a move back unconfirmed, not failed, when its answer was lost and Meta's read still lags", async () => {
    const clock = fakeClock();
    stubMeta({
      ...READY,
      "POST /6001_888": [{ success: true }],
      // Moved off, then the move back's answer is lost; the read still shows the copy.
      "POST /3001": [{ success: true }, lostAnswer],
      "GET /3001": [{ id: "3001", creative: { id: "4900" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "unconfirmed", creative_id: "4900" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated" });
  });

  it("leaves the ads of an own creative on the temporary one when their new creative cannot be made", async () => {
    const clock = fakeClock();
    stubMeta({
      ...READY,
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4901" }, { error: { code: 100, message: "Rejected" } }],
      "POST /6001_888": [{ success: true }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.edited).toBe(true);
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "left_on_temporary", creative_id: "4900" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated", creative_id: "4002" });
  });

  it("goes on as edited when the edit's answer is lost but the post has the new text", async () => {
    const clock = fakeClock();
    stubMeta({
      ...READY,
      "POST /6001_888": [lostAnswer],
      "GET /6001_888": [{ id: "6001_888", message: "Nuevo" }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.edited).toBe(true);
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["updated", "updated"]);
  });

  it("treats an edit that may have gone through as unknown, even when a later attempt is turned down", async () => {
    const clock = fakeClock();
    stubMeta({
      ...READY,
      // The first answer is lost, the next one turned down (say, the permission was revoked).
      "POST /6001_888": [lostAnswer, { error: { code: 10, message: "(#10) Permission denied" } }],
      "GET /6001_888": [{ id: "6001_888", message: "Otro texto" }],
    }, clock);

    const outcome = await editPost(input(), clock);

    // Back to the creative that created the post would be refused if the edit
    // did go through: the ads move to creatives that work either way.
    expect(fetchCallSummary().filter((c) => c === "POST /6001_888")).toHaveLength(2);
    expect(outcome).toMatchObject({ edited: false, edit_unconfirmed: true });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "updated", creative_id: "4950" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated", creative_id: "4002" });
  });

  it("stops before running out of time and still ends within its deadline when Meta is slow", async () => {
    const clock = fakeClock();
    const users = Array.from({ length: 5 }, (_, i) => ({ ad_id: String(3001 + i), status: "ACTIVE", creative_id: "4001" }));
    stubMeta({ "POST /act_123/adcreatives": [{ id: "4900" }] }, clock, 9_000);

    const outcome = await editPost(input({ users }), clock, 120_000);

    expect(outcome.stage).toBe("time");
    expect(clock.now()).toBeLessThanOrEqual(120_000);
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["restored", "restored", "unchanged", "unchanged", "unchanged"]);
    expect(fetchCallSummary()).not.toContain("POST /6001_888");
  });

  it("does not start the edit when moving every ad back afterwards would not fit", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY }, clock);

    const outcome = await editPost(input(), clock, 130_000);

    expect(outcome.stage).toBe("time");
    expect(fetchCallSummary()).not.toContain("GET /6001");
    expect(fetchCallSummary()).not.toContain("POST /6001_888");
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["restored", "restored"]);
    expect(clock.now()).toBeLessThanOrEqual(130_000);
  });

  it("keeps the text options of an own creative on its replacement", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [{ success: true }] }, clock);
    const feed = { bodies: [{ text: "Uno" }, { text: "Dos" }], optimization_type: "DEGREES_OF_FREEDOM" };

    await editPost(input({
      users: [{ ad_id: "3001", status: "PAUSED", creative_id: "4001" }],
      creatives: { 4001: { ...OWN, asset_feed_spec: feed } },
    }), clock);

    const replacement = vi.mocked(fetch).mock.calls.findIndex((call, i) => i > 0 && String(call[0]).includes("/adcreatives"));
    expect(json(body(replacement).get("asset_feed_spec"))).toEqual(feed);
    expect(body(replacement).get("object_story_id")).toBe("6001_888");
  });

  it("gives each ad a temporary copy of itself: destination, tracking, per-platform media and Instagram identity", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [{ success: true }] }, clock);
    const rich = {
      ...REUSE,
      instagram_user_id: "17841400000000009",
      url_tags: "utm_source=reuse",
      link_url: "https://example.com/override",
      platform_customizations: { instagram: { image_hash: "ig1" } },
    } as AdCreative;

    await editPost(input({ creatives: { 4001: OWN, 4002: rich } }), clock);

    const copy = body(1);
    expect(json(copy.get("object_story_spec"))).toMatchObject({
      instagram_user_id: "17841400000000009",
      link_data: { link: LINK, image_hash: "h1", message: "Nuevo" },
    });
    expect(copy.get("link_url")).toBe("https://example.com/override");
    expect(copy.get("url_tags")).toBe("utm_source=reuse");
    expect(json(copy.get("platform_customizations"))).toEqual({ instagram: { image_hash: "ig1" } });
    // Each ad waits on its own copy.
    expect(json(body(3).get("creative"))).toEqual({ creative_id: "4901" });
  });

  it("keeps the text options of an ad that shows them on its temporary copy", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [{ success: true }] }, clock);
    const feed = { bodies: [{ text: "Uno" }, { text: "Dos" }], titles: [{ text: "T1" }], optimization_type: "DEGREES_OF_FREEDOM" };
    const withOptions = { ...REUSE, asset_feed_spec: feed } as AdCreative;

    await editPost(input({ creatives: { 4001: OWN, 4002: withOptions } }), clock);

    const copy = body(1);
    expect(json(copy.get("asset_feed_spec"))).toEqual(feed);
    expect(json(copy.get("object_story_spec")).link_data).not.toHaveProperty("message");
  });

  it("makes the temporary creative from a video ad's own spec too", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [{ success: true }] }, clock);
    const video: AdCreative = {
      id: "4001", name: "Video", effective_object_story_id: "6001_888",
      object_story_spec: { page_id: "6001", video_data: { video_id: "8", image_hash: "t", message: "Viejo", call_to_action: { type: "LEARN_MORE", value: { link: LINK } } } },
    };

    await editPost(input({ creatives: { 4001: video, 4002: REUSE } }), clock);

    expect(json(body(0).get("object_story_spec")).video_data).toMatchObject({ video_id: "8", message: "Nuevo" });
  });

  it("builds the temporary creative from the post's link when only reusing creatives use it", async () => {
    const clock = fakeClock();
    stubMeta({ ...READY, "POST /6001_888": [{ success: true }] }, clock);

    await editPost(input({
      post: { post_id: "6001_888", page_id: "6001", message: "Nuevo", reuses_post: true },
      users: [{ ad_id: "3002", status: "PAUSED", creative_id: "4002" }],
      creatives: { 4002: REUSE },
    }), clock);

    expect(json(body(0).get("object_story_spec"))).toEqual({
      page_id: "6001",
      link_data: { link: "https://www.facebook.com/6001", message: "Nuevo" },
    });
  });
});

describe("hasServableTemporary", () => {
  it("is true only when a creative on the post created it, so the temporary one is a real copy of the ad", () => {
    expect(hasServableTemporary({ users: [{ ad_id: "3001", status: "ACTIVE", creative_id: "4001" }], creatives: { 4001: OWN } })).toBe(true);
    expect(hasServableTemporary({ users: [{ ad_id: "3002", status: "ACTIVE", creative_id: "4002" }], creatives: { 4002: REUSE } })).toBe(false);
  });
});

describe("findPostUsers", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
  });

  it("finds every ad of the account on the post, Meta offering no filter for it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      data: [
        { id: "3001", status: "ACTIVE", creative: { id: "4001", effective_object_story_id: "6001_888" } },
        { id: "3003", status: "PAUSED", creative: { id: "4003", effective_object_story_id: "6001_111" } },
        { id: "3002", status: "PAUSED", creative: { id: "4002", effective_object_story_id: "6001_888" } },
      ],
    })));

    const found = await findPostUsers("123", "6001_888");

    expect(found).toEqual({
      complete: true,
      users: [
        { ad_id: "3001", status: "ACTIVE", creative_id: "4001" },
        { ad_id: "3002", status: "PAUSED", creative_id: "4002" },
      ],
    });
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/act_123\/ads$/);
    expect(url.searchParams.get("fields")).toBe("id,status,creative{id,effective_object_story_id}");
  });

  it("says when the account has more ads than it can check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      data: [
        { id: "3001", status: "ACTIVE", creative: { id: "4001", effective_object_story_id: "6001_888" } },
        { id: "3002", status: "ACTIVE", creative: { id: "4002", effective_object_story_id: "6001_111" } },
        { id: "3003", status: "ACTIVE", creative: { id: "4003", effective_object_story_id: "6001_222" } },
      ],
    })));

    expect((await findPostUsers("123", "6001_888", 2)).complete).toBe(false);
  });
});
