import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { editPost, findPostUsers, type PostEditInput } from "../../src/meta/post-edit.js";
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
// The client retries such answers after 1, 2 and 4 real seconds; the retries
// themselves are not under test here.
const skipClientBackoff = () =>
  vi.spyOn(metaApiClient as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue();
const body = (index: number) => new URLSearchParams(String(vi.mocked(fetch).mock.calls[index][1]?.body ?? ""));
const tokenOf = (index: number) =>
  new URL(String(vi.mocked(fetch).mock.calls[index][0])).searchParams.get("access_token") ?? body(index).get("access_token");
const json = (value: string | null) => (value === null ? null : JSON.parse(value));

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

  it("pauses, detaches, edits the post, reattaches and resumes, in that order", async () => {
    const clock = fakeClock();
    const times = stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [failedEdit, { success: true }],
      "DELETE /4900": [{ error: { code: 100, error_subcode: 3858800, message: "In use" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(fetchCallSummary()).toEqual([
      "POST /act_123/adcreatives",
      "POST /3001", "POST /3001", "POST /3002",
      "GET /4900",
      "GET /6001", "POST /6001_888", "POST /6001_888",
      "POST /act_123/adcreatives",
      "POST /3001", "POST /3002",
      "DELETE /4900",
    ]);
    // A temporary creative of its own post, carrying the new text.
    expect(json(body(0).get("object_story_spec")).link_data.message).toBe("Nuevo");
    expect(body(1).get("status")).toBe("PAUSED");
    expect(json(body(2).get("creative"))).toEqual({ creative_id: "4900" });
    expect(json(body(3).get("creative"))).toEqual({ creative_id: "4900" });
    // The edit goes with the Page token, the rest with the person's.
    expect(body(7).get("message")).toBe("Nuevo");
    expect(tokenOf(7)).toBe(PAGE_TOKEN);
    expect(tokenOf(9)).not.toBe(PAGE_TOKEN);
    // The own creative cannot carry the ad again: a creative reusing the post does.
    expect(body(8).get("object_story_id")).toBe("6001_888");
    expect(body(8).get("object_story_spec")).toBeNull();
    expect(body(8).get("instagram_user_id")).toBe("17841400000000001");
    expect(body(8).get("url_tags")).toBe("utm_source=meta");
    expect(json(body(8).get("adlabels"))).toEqual([{ id: "900" }]);
    // Moved back and resumed in one write: never active on another creative.
    expect(json(body(9).get("creative"))).toEqual({ creative_id: "4950" });
    expect(body(9).get("status")).toBe("ACTIVE");
    // Was paused before the edit: moved back, left paused.
    expect(json(body(10).get("creative"))).toEqual({ creative_id: "4002" });
    expect(body(10).get("status")).toBeNull();
    // Meta allows one creative change per ad every 30 seconds.
    expect(times[9] - times[2]).toBeGreaterThanOrEqual(30_000);
    expect(times[10] - times[3]).toBeGreaterThanOrEqual(30_000);

    expect(outcome).toMatchObject({
      edited: true,
      temporary_creative_id: "4900",
      temporary_deleted: false,
      new_creatives: ["4950"],
      ads: [
        { ad_id: "3001", outcome: "updated", creative_id: "4950", previous_creative_id: "4001", instagram: "reset", resumed: true },
        { ad_id: "3002", outcome: "updated", creative_id: "4002", previous_creative_id: "4002", instagram: "kept", resumed: false },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain(PAGE_TOKEN);
  });

  it("puts every ad back on its own creative and resumes it when Meta never accepts the edit", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [failedEdit],
      // Read after the last refusal: the post still has its old text.
      "GET /6001_888": [{ id: "6001_888", message: "Viejo" }],
      "GET /3001": [{ id: "3001", creative: { id: "4001" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    const calls = fetchCallSummary();
    expect(calls.filter((c) => c === "POST /6001_888").length).toBeGreaterThan(5);
    expect(calls.filter((c) => c === "POST /act_123/adcreatives")).toHaveLength(1);
    // Meta turned each attempt down, so nothing was written: no need to read the post.
    expect(calls).not.toContain("GET /6001_888");
    expect(outcome).toMatchObject({
      edited: false,
      stage: "edit",
      ads: [
        { ad_id: "3001", outcome: "restored", creative_id: "4001", instagram: "kept", resumed: true },
        { ad_id: "3002", outcome: "restored", creative_id: "4002", instagram: "kept", resumed: false },
      ],
    });
    expect(outcome.error).toContain("Failed to edit object");
  });

  it("undoes the detach and never edits when an ad cannot be detached", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3002": [{ error: { code: 100, message: "Refused" } }],
      "GET /3002": [{ id: "3002", creative: { id: "4002" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4001" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    const calls = fetchCallSummary();
    expect(calls).not.toContain("GET /6001");
    expect(calls).not.toContain("POST /6001_888");
    expect(outcome).toMatchObject({
      edited: false,
      stage: "detach",
      ads: [
        { ad_id: "3001", outcome: "restored", creative_id: "4001", resumed: true },
        { ad_id: "3002", outcome: "unchanged", creative_id: "4002", resumed: false },
      ],
    });
  });

  it("resumes an ad whose pause Meta reported as failed but applied", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3001": [{ error: { code: 100, message: "Lost response" } }, { success: true }],
      "GET /3001": [{ id: "3001", status: "PAUSED", creative: { id: "4001" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome).toMatchObject({ edited: false, stage: "pause" });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "unchanged", resumed: true });
    expect(body(fetchCallSummary().lastIndexOf("POST /3001")).get("status")).toBe("ACTIVE");
  });

  it("moves back an ad whose detach failed and whose creative could not be read", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3002": [{ error: { code: 100, message: "Lost response" } }, { success: true }],
      "GET /3002": [{ error: { code: 100, message: "Unavailable" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4001" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    // Its state is unknown, so it is pointed back at its own creative too.
    const lastMove = fetchCallSummary().lastIndexOf("POST /3002");
    expect(json(body(lastMove).get("creative"))).toEqual({ creative_id: "4002" });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "restored", creative_id: "4002" });
  });

  it("does not edit when the temporary creative turns out to use the same post", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_888" }],
      "GET /3001": [{ id: "3001", creative: { id: "4001" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(fetchCallSummary()).not.toContain("POST /6001_888");
    expect(outcome).toMatchObject({ edited: false, stage: "wait" });
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["restored", "restored"]);
  });

  it("leaves an ad paused on the temporary creative when it cannot be reattached, and says so", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [{ success: true }],
      // pause, detach, then the reattach is refused
      "POST /3001": [{ success: true }, { success: true }, { error: { code: 100, message: "Refused" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4900" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "left_on_temporary", creative_id: "4900", resumed: false });
    expect(outcome.ads[0].error).toContain("Refused");
    // Not resumed: it would show the temporary creative.
    expect(fetchCallSummary().filter((c) => c === "POST /3001")).toHaveLength(3);
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated" });
  });

  it("leaves the ads of an own creative on the temporary one when their new creative cannot be made", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { error: { code: 100, message: "Rejected" } }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [{ success: true }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.edited).toBe(true);
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "left_on_temporary", creative_id: "4900", resumed: false });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated", creative_id: "4002" });
  });

  it("never resumes an ad found on a creative this edit did not put it on", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      // Another edit of the post moved 3001 to its own temporary creative.
      "POST /3001": [{ success: true }, { error: { code: 100, message: "Refused" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4777" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome).toMatchObject({ edited: false, stage: "detach" });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", creative_id: "4777", resumed: false });
    expect(outcome.ads[0].error).toMatch(/stays paused/);
    expect(fetchCallSummary().filter((c) => c === "POST /3001")).toHaveLength(2);
  });

  it("treats a pause it cannot confirm either way as done, and says so if the ad cannot be resumed safely", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3001": [{ error: { code: 100, message: "Lost response" } }],
      "GET /3001": [{ error: { code: 100, message: "Unavailable" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome).toMatchObject({ edited: false, stage: "pause" });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", resumed: false });
    expect(outcome.ads[0].error).toMatch(/may be paused|stays paused/);
  });

  it("goes on as edited when the edit's answer is lost but the post has the new text", async () => {
    skipClientBackoff();
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [lostAnswer],
      "GET /6001_888": [{ id: "6001_888", message: "Nuevo" }],
      "GET /3001": [{ id: "3001", creative: { id: "4950" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.edited).toBe(true);
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["updated", "updated"]);
  });

  it("moves every ad onto creatives that work either way when it cannot tell whether the post was edited", async () => {
    skipClientBackoff();
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [lostAnswer],
      "GET /6001_888": [{ error: { code: 100, message: "Unavailable" } }],
      "GET /3001": [{ id: "3001", creative: { id: "4950" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    // A creative reusing the post carries the ad whether or not the text changed.
    expect(outcome).toMatchObject({ edited: false, edit_unconfirmed: true });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "updated", creative_id: "4950", resumed: true });
    expect(outcome.ads[1]).toMatchObject({ ad_id: "3002", outcome: "updated", creative_id: "4002" });
  });

  it("puts everything back without editing when Meta is too slow to finish within a call", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "GET /3001": [{ id: "3001", creative: { id: "4001" } }],
    }, clock, 20_000);

    const outcome = await editPost(input(), clock);

    expect(fetchCallSummary()).not.toContain("POST /6001_888");
    expect(outcome).toMatchObject({ edited: false, stage: "time" });
    expect(outcome.ads.map((a) => a.outcome)).toEqual(["restored", "restored"]);
  });

  it("does not resume an ad read back on another ad's creative", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "POST /3001": [{ success: true }, { error: { code: 100, message: "Refused" } }],
      // 4002 is 3002's creative, a planned one, but not 3001's.
      "GET /3001": [{ id: "3001", status: "PAUSED", creative: { id: "4002" } }],
    }, clock);

    const outcome = await editPost(input(), clock);

    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", creative_id: "4002", resumed: false });
    expect(outcome.ads[0].error).toMatch(/stays paused/);
    expect(fetchCallSummary().filter((c) => c === "POST /3001")).toHaveLength(2);
  });

  it("treats another text read back after a lost answer as unknown, not as unedited", async () => {
    skipClientBackoff();
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [lostAnswer],
      // Someone may have edited it again after this edit went through.
      "GET /6001_888": [{ id: "6001_888", message: "Otro texto" }],
    }, clock);

    const outcome = await editPost(input(), clock);

    // Back to the creative that created the post would be refused if the edit
    // did go through: the ads move to creatives that work either way.
    expect(outcome).toMatchObject({ edited: false, edit_unconfirmed: true });
    expect(outcome.ads[0]).toMatchObject({ ad_id: "3001", outcome: "updated", creative_id: "4950" });
  });

  it("stops early and still ends within its deadline when Meta is very slow, with ten ads", async () => {
    const clock = fakeClock();
    const users = Array.from({ length: 10 }, (_, i) => ({ ad_id: String(3001 + i), status: "ACTIVE", creative_id: "4002" }));
    stubMeta({ "POST /act_123/adcreatives": [{ id: "4900" }] }, clock, 20_000);

    const outcome = await editPost(input({ users, creatives: { 4002: REUSE } }), clock);

    expect(outcome.stage).toBe("time");
    expect(clock.now()).toBeLessThanOrEqual(240_000);
    const paused = fetchCallSummary().filter((c) => c.startsWith("POST /30")).length / 2;
    expect(outcome.ads.filter((a) => a.resumed)).toHaveLength(paused);
    // No ad was moved: stopping before the first move costs less than undoing it.
    expect(vi.mocked(fetch).mock.calls.some((call) => String(call[1]?.body ?? "").includes("4900"))).toBe(false);
  });

  it("keeps the text options of an own creative on its replacement", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }, { id: "4950" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [{ success: true }],
    }, clock);
    const feed = { bodies: [{ text: "Uno" }, { text: "Dos" }], optimization_type: "DEGREES_OF_FREEDOM" };

    await editPost(input({
      users: [{ ad_id: "3001", status: "PAUSED", creative_id: "4001" }],
      creatives: { 4001: { ...OWN, asset_feed_spec: feed } },
    }), clock);

    const replacement = vi.mocked(fetch).mock.calls.findIndex((call, i) => i > 0 && String(call[0]).includes("/adcreatives"));
    expect(json(body(replacement).get("asset_feed_spec"))).toEqual(feed);
    expect(body(replacement).get("object_story_id")).toBe("6001_888");
  });

  it("builds the temporary creative from the post's link when only reusing creatives use it", async () => {
    const clock = fakeClock();
    stubMeta({
      "POST /act_123/adcreatives": [{ id: "4900" }],
      "GET /4900": [{ id: "4900", effective_object_story_id: "6001_999" }],
      "GET /6001": [{ id: "6001", access_token: PAGE_TOKEN }],
      "POST /6001_888": [{ success: true }],
    }, clock);

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
