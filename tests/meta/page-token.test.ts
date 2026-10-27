import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { grantedPermissions, withPageToken } from "../../src/meta/page-token.js";
import { metaApiClient } from "../../src/meta/client.js";
import { getAccessToken } from "../../src/auth/token-store.js";
import { logger } from "../../src/utils/logger.js";
import { setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

const PAGE_TOKEN = "page-token-never-shown";
const tokenOf = (call: number) => new URL(String(vi.mocked(fetch).mock.calls[call][0])).searchParams.get("access_token")
  ?? new URLSearchParams(String(vi.mocked(fetch).mock.calls[call][1]?.body ?? "")).get("access_token");

describe("withPageToken", () => {
  beforeEach(() => {
    setupTestToken("user-token");
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for the Page token with the person's token and runs only the given work with it", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: PAGE_TOKEN }))
      .mockResolvedValueOnce(mockFetchResponse({ success: true })));

    const seen = await withPageToken("6001", async () => {
      const inside = getAccessToken();
      await metaApiClient.postForm("/6001_777", { message: "Nuevo" });
      return inside;
    });

    expect(seen).toBe(PAGE_TOKEN);
    expect(getAccessToken()).toBe("user-token");
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.get("fields")).toBe("access_token");
    expect(tokenOf(0)).toBe("user-token");
    expect(tokenOf(1)).toBe(PAGE_TOKEN);
  });

  it("refuses without calling the work when Meta returns no Page token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "6001" })));
    const work = vi.fn();

    await expect(withPageToken("6001", work)).rejects.toThrow(/no Page access token for page 6001/);
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses a page ID that is not a Meta ID before calling Meta", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(withPageToken("6001/feed", vi.fn())).rejects.toThrow(/Invalid Meta page/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("keeps the Page token out of errors and logs when the work fails", async () => {
    const logged: unknown[] = [];
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
    }
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: PAGE_TOKEN }))
      .mockResolvedValueOnce(mockFetchResponse({ error: { code: 100, message: "(#100) Failed to edit object" } }, { status: 400 })));

    const error = await withPageToken("6001", () => metaApiClient.postForm("/6001_777", { message: "Nuevo" })).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(logged)).not.toContain(PAGE_TOKEN);
  });
});

describe("grantedPermissions", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
  });

  it("lists only the permissions the person granted", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({
      data: [
        { permission: "ads_management", status: "granted" },
        { permission: "pages_manage_posts", status: "declined" },
        { permission: "pages_show_list", status: "granted" },
      ],
    })));

    expect(await grantedPermissions()).toEqual(new Set(["ads_management", "pages_show_list"]));
    expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).pathname).toMatch(/\/me\/permissions$/);
  });
});
