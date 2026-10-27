import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  fetchPrimaryBusiness,
  loadMetaOAuthConfig,
  oauthScopes,
} from "../../src/auth/meta-oauth.js";
import { mockFetchResponse } from "../setup.js";

describe("Meta OAuth Graph API version", () => {
  const serverUrl = new URL("https://mcp.example.com");

  beforeEach(() => {
    vi.stubEnv("META_APP_ID", "1234567890");
    vi.stubEnv("META_APP_SECRET", "dummy-secret");
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs the login dialog and Graph calls on v26.0 by default", async () => {
    vi.stubEnv("META_API_VERSION", undefined);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    const config = loadMetaOAuthConfig(serverUrl);
    const dialogUrl = new URL(buildAuthorizeUrl(config!, "state-1"));
    await fetchPrimaryBusiness("token-x");

    expect(dialogUrl.pathname).toBe("/v26.0/dialog/oauth");
    const graphUrl = new URL(vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(graphUrl.pathname).toBe("/v26.0/me/businesses");
  });

  it("follows META_API_VERSION for the login dialog and Graph calls", async () => {
    vi.stubEnv("META_API_VERSION", "v25.0");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    const config = loadMetaOAuthConfig(serverUrl);
    const dialogUrl = new URL(buildAuthorizeUrl(config!, "state-1"));
    await fetchPrimaryBusiness("token-x");

    expect(dialogUrl.pathname).toBe("/v25.0/dialog/oauth");
    const graphUrl = new URL(vi.mocked(globalThis.fetch).mock.calls[0][0] as string);
    expect(graphUrl.pathname).toBe("/v25.0/me/businesses");
  });
});

describe("Meta OAuth scopes", () => {
  const serverUrl = new URL("https://mcp.example.com");
  const scopesOf = () => new URL(buildAuthorizeUrl(loadMetaOAuthConfig(serverUrl)!, "state-1")).searchParams.get("scope")!.split(",");

  beforeEach(() => {
    vi.stubEnv("META_APP_ID", "1234567890");
    vi.stubEnv("META_APP_SECRET", "dummy-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks only for the default scopes unless the operator opts in to more", () => {
    vi.stubEnv("META_OAUTH_EXTRA_SCOPES", undefined);
    expect(scopesOf()).toEqual([
      "ads_management", "ads_read", "pages_show_list", "pages_read_engagement",
      "business_management", "whatsapp_business_management", "email", "public_profile",
    ]);
    expect(oauthScopes()).toEqual(scopesOf());
  });

  it("adds the reviewed scopes listed in META_OAUTH_EXTRA_SCOPES, once each", () => {
    vi.stubEnv("META_OAUTH_EXTRA_SCOPES", " pages_manage_posts, pages_read_user_content ,pages_manage_posts,ads_read");
    const scopes = scopesOf();
    expect(scopes.slice(-2)).toEqual(["pages_manage_posts", "pages_read_user_content"]);
    expect(scopes.filter((s) => s === "ads_read")).toHaveLength(1);
  });

  it("never asks for a scope outside its list, whatever the variable says", () => {
    vi.stubEnv("META_OAUTH_EXTRA_SCOPES", "pages_manage_posts,user_messenger_contact,&redirect_uri=https://evil.example");
    const scopes = scopesOf();
    expect(scopes).toContain("pages_manage_posts");
    expect(scopes).not.toContain("user_messenger_contact");
    expect(scopes.join(",")).not.toContain("evil");
  });
});

describe("fetchPrimaryBusiness", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns id and name for the first business", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: [{ id: "1234567890", name: "Acme Corp" }],
      }),
    );

    const result = await fetchPrimaryBusiness("token-x", "v22.0");
    expect(result).toEqual({ id: "1234567890", name: "Acme Corp" });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/v22.0/me/businesses");
    expect(url).toContain("fields=id%2Cname");
    expect(url).toContain("limit=1");
    expect(url).toContain("access_token=token-x");
  });

  it("returns null when the businesses list is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("returns null when the API responds with an error (missing permission)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse(
        {
          error: {
            message:
              "(#200) Permissions error: business_management is required",
          },
        },
        { status: 400 },
      ),
    );

    const result = await fetchPrimaryBusiness("token-no-perm");
    expect(result).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network down"));

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("preserves the id and tolerates a missing name", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [{ id: "9999" }] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toEqual({ id: "9999", name: null });
  });
});
