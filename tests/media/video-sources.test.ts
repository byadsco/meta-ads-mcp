import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fbcdnExpiresAt,
  resolveMetaVideoSources,
  resolveMetaVideoSourcesWithInfo,
  resourceUriFor,
} from "../../src/media/video-sources.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

function fetchCalls(): string[] {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

const VIDEO = {
  id: "999",
  title: "Hook test",
  source: "https://video.xx.fbcdn.net/v.mp4?oe=69617495",
  picture: "https://scontent.xx.fbcdn.net/small.jpg",
  thumbnails: { data: [{ uri: "https://scontent.xx.fbcdn.net/big.jpg", width: 1080, height: 1920 }] },
  length: 15.2,
  permalink_url: "https://www.facebook.com/999",
  status: { video_status: "ready" },
};

describe("fbcdnExpiresAt", () => {
  it("decodes the hex oe parameter into an ISO timestamp", () => {
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oh=x&oe=69617495")).toBe("2026-01-09T21:35:17.000Z");
  });

  it("returns undefined for missing or implausible values", () => {
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4")).toBeUndefined();
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oe=zz")).toBeUndefined();
    expect(fbcdnExpiresAt("https://video.xx.fbcdn.net/v.mp4?oe=1")).toBeUndefined();
    expect(fbcdnExpiresAt(undefined)).toBeUndefined();
  });
});

describe("resourceUriFor", () => {
  it("builds stable uris for meta and ad library videos", () => {
    expect(resourceUriFor({ key: "k", label: "l", origin: "meta", video_id: "123" })).toBe("meta-ads://video/123");
    expect(resourceUriFor({ key: "k", label: "l", origin: "ad_library", ad_archive_id: "555", card_index: 2 })).toBe("meta-ads://ad-library/555/video/2");
  });
});

describe("resolveMetaVideoSources", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves a video_id through the Graph video endpoint including permalink_url", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(VIDEO)));

    const sources = await resolveMetaVideoSources({ video_id: "999" });

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      key: "meta:video:999",
      origin: "meta",
      video_id: "999",
      source_url: VIDEO.source,
      thumbnail_url: "https://scontent.xx.fbcdn.net/big.jpg",
      duration_seconds: 15.2,
      permalink_url: "https://www.facebook.com/999",
      title: "Hook test",
    });
    expect(fetchCalls()[0]).toMatch(/\/999\?/);
    expect(fetchCalls()[0]).toMatch(/permalink_url/);
  });

  it("resolves every video referenced by a creative, capped at max_videos", async () => {
    const creative = {
      id: "7001",
      name: "Carousel",
      object_story_spec: {
        link_data: {
          child_attachments: [
            { video_id: "9101", picture: "https://scontent.xx.fbcdn.net/c1.jpg" },
            { video_id: "9102" },
            { video_id: "9103" },
          ],
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse(creative))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9101" }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9102" })),
    );

    const { sources, truncated } = await resolveMetaVideoSourcesWithInfo({ creative_id: "7001", max_videos: 2 });

    expect(sources.map((s) => s.video_id)).toEqual(["9101", "9102"]);
    expect(truncated).toBe(1);
    expect(fetchCalls()).toHaveLength(3);
  });

  it("resolves an ad through its creative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "8001", account_id: "123", creative: { id: "7001" } }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { video_data: { video_id: "9109" } } }))
        .mockResolvedValueOnce(mockFetchResponse({ ...VIDEO, id: "9109" })),
    );

    const sources = await resolveMetaVideoSources({ ad_id: "8001" });
    expect(sources.map((s) => s.video_id)).toEqual(["9109"]);
    expect(sources[0].label).toContain("9109");
  });

  it("keeps a failed video lookup as a source with an error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({ id: "7001", object_story_spec: { video_data: { video_id: "9109", image_url: "https://scontent.xx.fbcdn.net/t.jpg" } } }))
        .mockResolvedValueOnce(mockFetchResponse({ error: { message: "Unsupported get request", code: 100 } }, { status: 400 })),
    );

    const sources = await resolveMetaVideoSources({ creative_id: "7001" });
    expect(sources).toHaveLength(1);
    expect(sources[0].error).toMatch(/Unsupported get request/);
    expect(sources[0].source_url).toBeUndefined();
    expect(sources[0].thumbnail_url).toBe("https://scontent.xx.fbcdn.net/t.jpg");
  });

  it("rejects invalid ids before calling Graph", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(resolveMetaVideoSources({ video_id: "../etc" })).rejects.toThrow(/Invalid/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns no sources for a creative without videos", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "7001", image_url: "https://scontent.xx.fbcdn.net/i.jpg" })));
    expect(await resolveMetaVideoSources({ creative_id: "7001" })).toEqual([]);
  });
});
