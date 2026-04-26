import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  oauthProvider,
  resetOAuthProviderForTests,
} from "../../src/auth/oauth-provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const original = process.env.OAUTH_SECRET;

const fakeClient: OAuthClientInformationFull = {
  client_id: "test-client",
  client_name: "Test",
  redirect_uris: ["https://example.com/cb"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_id_issued_at: Math.floor(Date.now() / 1000),
};

function fakeRes(): Response {
  const stub = {
    redirect: vi.fn(),
  } as unknown as Response;
  return stub;
}

describe("MetaAdsOAuthProvider", () => {
  beforeEach(() => {
    process.env.OAUTH_SECRET = "x".repeat(64);
    resetOAuthProviderForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OAUTH_SECRET;
    else process.env.OAUTH_SECRET = original;
    resetOAuthProviderForTests();
  });

  it("issues a code that can be exchanged for tokens including fb_user_id (and never the token name)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-1234" }),
    });

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );

    expect((res.redirect as never as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      1,
    );
    const redirected = (res.redirect as never as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const url = new URL(redirected);
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code!,
    );
    expect(tokens.access_token).toBeTruthy();

    const authInfo = await oauthProvider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe("test-client");
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-1234",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
  });

  it("rejects auth code that was issued to a different client", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    const otherClient: OAuthClientInformationFull = {
      ...fakeClient,
      client_id: "other-client",
    };

    await expect(
      oauthProvider.exchangeAuthorizationCode(otherClient, code),
    ).rejects.toThrow(/different client/);
  });

  it("CODE-A1: code consume() is single-use under concurrent exchange (race fix)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    // Two concurrent exchanges race. With the atomic consume(), exactly
    // one wins.
    const settled = await Promise.allSettled([
      oauthProvider.exchangeAuthorizationCode(fakeClient, code),
      oauthProvider.exchangeAuthorizationCode(fakeClient, code),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /Invalid authorization code/,
    );
  });

  it("CODE-C3: rejects mismatched PKCE verifier when supplied", async () => {
    const verifier = "a".repeat(64);
    const challenge = (await import("node:crypto"))
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    await expect(
      oauthProvider.exchangeAuthorizationCode(
        fakeClient,
        code,
        "wrong-verifier",
      ),
    ).rejects.toThrow(/PKCE verification failed/);
  });

  it("CODE-C3: accepts a matching PKCE verifier", async () => {
    const verifier = "b".repeat(64);
    const challenge = (await import("node:crypto"))
      .createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
      verifier,
    );
    expect(tokens.access_token).toBeTruthy();
  });

  it("CODE-A2: refresh token can only be used once (rotation)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-rotate" }),
    });
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    // First refresh succeeds and rotates the jti.
    const refreshed = await oauthProvider.exchangeRefreshToken(
      fakeClient,
      tokens.refresh_token!,
    );
    expect(refreshed.access_token).toBeTruthy();

    // Same refresh token again must fail (jti deleted on rotation).
    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ).rejects.toThrow(/revoked|already used/i);
  });

  it("CODE-A2: refresh-token rotation is atomic under concurrent exchange", async () => {
    // Two concurrent exchanges of the same refresh token must produce
    // exactly one fulfilled and one rejected. Without atomic consume,
    // both would see has=true before either delete and both would mint
    // new pairs (replay window).
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    const settled = await Promise.allSettled([
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /revoked|already used/i,
    );
  });

  it("CODE-A2: revokeToken invalidates the refresh token (RFC 7009)", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    await oauthProvider.revokeToken(fakeClient, {
      token: tokens.refresh_token!,
    });

    await expect(
      oauthProvider.exchangeRefreshToken(fakeClient, tokens.refresh_token!),
    ).rejects.toThrow(/revoked|already used/i);
  });

  it("preserves fb_user_id across refresh-token exchange (token name is never in the JWT)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-9999" }),
    });
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    const refreshed = await oauthProvider.exchangeRefreshToken(
      fakeClient,
      tokens.refresh_token!,
    );
    const authInfo = await oauthProvider.verifyAccessToken(refreshed.access_token);
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-9999",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
  });
});
