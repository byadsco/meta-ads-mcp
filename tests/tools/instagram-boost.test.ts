import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInstagramTools, setBoostRecoveryWaitsForTests } from "../../src/tools/instagram.js";
import { metaApiClient } from "../../src/meta/client.js";
import { cleanupTestToken, createMockMcpServer, fetchCallSummary, mockFetchResponse, setupTestToken } from "../setup.js";

type TextResult = { content: Array<{ type: string; text: string }> };
type Outcome = "ok" | "refused" | "lost";

interface Stub {
  adSetAccount?: string;
  eligibility?: Record<string, unknown> | undefined;
  ad?: Outcome;
  creativeRead?: "ok" | "fails";
  /** The ads Meta lists under the run's tag before the write, and after it. */
  taggedBefore?: boolean;
  taggedAfter?: boolean;
  /** Pages of the tag lookup before the write, as name suffixes after the tag ("" is the tag itself); next = Meta says there is more. */
  lookupPages?: Array<{ suffixes: string[]; next: boolean }>;
}

const refusal = () => mockFetchResponse({ error: { code: 100, type: "OAuthException", message: "Invalid parameter", error_user_msg: "This post cannot run in this ad set" } }, { status: 400 });

// Measured on v26.0: one POST /act/ads with the creative spec inline makes
// the ad and its creative from the post, so there is a single write.
function stubMeta(options: Stub = {}) {
  const { adSetAccount = "123", ad = "ok", creativeRead = "ok", taggedBefore = false, taggedAfter = false, lookupPages } = options;
  let lookups = 0;
  const eligibility = "eligibility" in options ? options.eligibility : { eligible_to_boost: true };
  let posted = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname: path, searchParams } = new URL(url);
    if (init?.method === "POST" && /\/ads$/.test(path)) {
      posted = true;
      if (ad === "lost") throw new TypeError("fetch failed");
      return ad === "refused" ? refusal() : mockFetchResponse({ id: "5001" });
    }
    if (/\/3001\/ads$/.test(path)) {
      const tag = JSON.parse(searchParams.get("filtering")!)[0].value as string;
      if (!posted && lookupPages) {
        const page = lookupPages[Math.min(lookups, lookupPages.length - 1)];
        lookups += 1;
        return mockFetchResponse({
          data: page.suffixes.map((suffix, i) => ({ id: String(5100 + lookups * 10 + i), name: `Earlier ${tag}${suffix}`, creative: { id: "4009" } })),
          ...(page.next ? { paging: { cursors: { after: `c${lookups}` }, next: "https://graph.facebook.com/next" } } : {}),
        });
      }
      const listed = posted ? taggedAfter : taggedBefore;
      return mockFetchResponse({ data: listed ? [{ id: "5009", name: `Earlier ${tag}`, creative: { id: "4009" } }] : [] });
    }
    if (/\/5001$/.test(path)) {
      return creativeRead === "ok" ? mockFetchResponse({ id: "5001", creative: { id: "4001" } }) : refusal();
    }
    if (/\/3001$/.test(path)) return mockFetchResponse({ id: "3001", account_id: adSetAccount });
    if (/\/1784$/.test(path)) {
      return mockFetchResponse({ id: "1784", media_type: "IMAGE", media_product_type: "FEED", ...(eligibility === undefined ? {} : { boost_eligibility_info: eligibility }) });
    }
    return mockFetchResponse({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 });
  }));
}

async function boost(args: Record<string, unknown> = {}): Promise<string> {
  const server = createMockMcpServer();
  registerInstagramTools(server as never);
  const tool = server._registeredTools.find((t) => t.name === "ads_boost_ig_post")!;
  const result = await tool.handler({
    account_id: "123", ad_set_id: "3001", instagram_media_id: "1784", instagram_account_id: "1780", ...args,
  }) as TextResult;
  return result.content.map((c) => c.text).join("\n");
}

const postBody = (call: number) => new URLSearchParams(vi.mocked(fetch).mock.calls[call][1]?.body as string);
const posts = () => fetchCallSummary().filter((c) => c.startsWith("POST"));

describe("ads_boost_ig_post", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    setBoostRecoveryWaitsForTests([0, 0]);
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("is registered after the Instagram lookups, under Meta's official name, as a write", () => {
    const server = createMockMcpServer();
    registerInstagramTools(server as never);
    const tool = server._registeredTools[2];
    expect(tool.name).toBe("ads_boost_ig_post");
    expect(tool.description).toMatch(/^⚠️/);
    expect(tool.annotations).toEqual({ destructiveHint: false, idempotentHint: false });
  });

  it("checks the ad set and the post, then makes the paused ad and its creative in one write", async () => {
    stubMeta();

    const text = await boost({ page_id: "6001", call_to_action_type: "LEARN_MORE", link_url: "https://example.com/" });

    expect(fetchCallSummary()).toEqual(["GET /3001", "GET /1784", "GET /3001/ads", "POST /act_123/ads", "GET /5001"]);
    const ad = postBody(3);
    expect(ad.get("adset_id")).toBe("3001");
    expect(ad.get("status")).toBe("PAUSED");
    const creative = JSON.parse(ad.get("creative")!);
    expect(creative.source_instagram_media_id).toBe("1784");
    expect(creative.instagram_user_id).toBe("1780");
    expect(creative.object_id).toBe("6001");
    expect(creative.call_to_action).toEqual({ type: "LEARN_MORE", value: { link: "https://example.com/" } });
    expect(creative.object_story_spec).toBeUndefined();
    expect(Object.values(creative.degrees_of_freedom_spec.creative_features_spec).every((f) => (f as { enroll_status: string }).enroll_status === "OPT_OUT")).toBe(true);
    expect(creative.contextual_multi_ads).toEqual({ enroll_status: "OPT_OUT" });
    expect(text).toContain("ad 5001");
    expect(text).toContain("creative 4001");
    expect(text).toMatch(/PAUSED/);
  });

  it("ends the ad's name with a tag drawn from the arguments: the same boost gets the same tag", async () => {
    const tagOf = async (args: Record<string, unknown>) => {
      stubMeta();
      await boost(args);
      return /\[boost [0-9a-f]{10}\]$/.exec(postBody(3).get("name")!)?.[0];
    };

    const first = await tagOf({ name: "Spring boost" });
    expect(first).toBeDefined();
    expect(await tagOf({ name: "Spring boost" })).toBe(first);
    expect(await tagOf({ name: "Autumn boost" })).not.toBe(first);
  });

  it("reads every page of the lookup, so copies on the first page do not hide the original on a later one", async () => {
    stubMeta({ lookupPages: [{ suffixes: [" - Copy", " - Copy", " - Copy", " - Copy", " - Copy"], next: true }, { suffixes: [""], next: false }] });

    const text = await boost();

    expect(posts()).toEqual([]);
    expect(text).toMatch(/already boosted.*ad 5120/i);
  });

  it("writes nothing when it cannot read the lookup to its end", async () => {
    stubMeta({ lookupPages: [{ suffixes: [" - Copy"], next: true }] });

    await expect(boost()).rejects.toThrow(/could not confirm.*nothing was created/);
    expect(posts()).toEqual([]);
  });

  it("returns the ad an earlier call of the same boost made, without writing again", async () => {
    stubMeta({ taggedBefore: true });

    const text = await boost();

    expect(posts()).toEqual([]);
    expect(text).toMatch(/already boosted.*ad 5009.*creative 4009/i);
  });

  it("still reports the ad when its creative cannot be read back", async () => {
    stubMeta({ creativeRead: "fails" });

    const text = await boost();

    expect(text).toContain("ad 5001");
    expect(text).toMatch(/creative could not be read back/);
  });

  it("refuses a post Meta says cannot be boosted, with Meta's reason, before writing anything", async () => {
    stubMeta({ eligibility: { eligible_to_boost: false, reason: "The post has music without the rights to promote" } });

    await expect(boost()).rejects.toThrow(/cannot be boosted.*music without the rights/);
    expect(posts()).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["empty", {}],
  ])("refuses a post whose eligibility Meta did not confirm (%s), before writing anything", async (_label, eligibility) => {
    stubMeta({ eligibility });

    await expect(boost()).rejects.toThrow(/did not confirm/);
    expect(posts()).toEqual([]);
  });

  it("refuses an ad set of another ad account before writing anything", async () => {
    stubMeta({ adSetAccount: "999" });

    await expect(boost()).rejects.toThrow(/ad set 3001 belongs to act_999, not act_123/);
    expect(posts()).toEqual([]);
  });

  it("says nothing was created when Meta refuses the ad", async () => {
    stubMeta({ ad: "refused" });

    await expect(boost()).rejects.toThrow(/Meta refused the ad.*no ad was created/);
    expect(posts()).toHaveLength(1);
  });

  it("when the answer is lost but the ad shows up, reports it", async () => {
    stubMeta({ ad: "lost", taggedAfter: true });

    const text = await boost();

    expect(text).toMatch(/answer was lost, but the ad exists.*ad 5009.*creative 4009/);
    expect(posts()).toHaveLength(1);
  });

  it("when the answer is lost and the ad does not show up, says so without promising a retry is safe", async () => {
    stubMeta({ ad: "lost" });

    const error = await boost().then(() => undefined, (e: Error) => e);

    expect(error?.message).toMatch(/may or may not exist/);
    expect(error?.message).toMatch(/same arguments.*looks for it first/);
    expect(error?.message).toMatch(/"name", operator: "CONTAIN", value: "\[boost [0-9a-f]{10}\]"/);
    expect(error?.message).not.toMatch(/\bsafe\b/);
    expect(posts()).toHaveLength(1);
  });

  it("refuses a link without a button, which Meta would drop, before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(boost({ link_url: "https://example.com/" })).rejects.toThrow(/link_url needs call_to_action_type/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("warns against boosting the same post again while Meta has not listed the new ad", async () => {
    stubMeta();
    expect(await boost()).toMatch(/Do not call ads_boost_ig_post again for this post/);
  });

  it.each([
    ["ad_set_id", { ad_set_id: "3001/ads" }],
    ["instagram_media_id", { instagram_media_id: "act_1784" }],
    ["instagram_account_id", { instagram_account_id: "me" }],
    ["page_id", { page_id: "6001?x=1" }],
  ])("refuses a malformed %s before calling Meta", async (field, args) => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(boost(args)).rejects.toThrow(new RegExp(field));
    expect(fetch).not.toHaveBeenCalled();
  });
});
