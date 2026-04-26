import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { logger } from "../utils/logger.js";
import {
  InMemoryAuthCodesStore,
  type AuthCodesStore,
} from "../store/persistent-auth-codes.js";
import { InMemoryClientsStore } from "../store/persistent-clients-store.js";
import {
  InMemoryJtiStore,
  type JtiStore,
} from "../store/persistent-jti-store.js";

let cachedSecret: Uint8Array | undefined;

function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.OAUTH_SECRET;
  if (secret) {
    cachedSecret = new TextEncoder().encode(secret);
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OAUTH_SECRET environment variable is required in production");
  }

  logger.warn("OAUTH_SECRET not set; generating random secret (tokens won't survive restart)");
  const randomSecret = crypto.randomBytes(32).toString("hex");
  process.env.OAUTH_SECRET = randomSecret;
  cachedSecret = new TextEncoder().encode(randomSecret);
  return cachedSecret;
}

export interface PendingAuthSession {
  fbUserId: string;
}

export class MetaAdsOAuthProvider implements OAuthServerProvider {
  private clientsStoreImpl: OAuthRegisteredClientsStore = new InMemoryClientsStore();
  private authCodesImpl: AuthCodesStore = new InMemoryAuthCodesStore();
  private refreshJtiStoreImpl: JtiStore = new InMemoryJtiStore();
  private pendingAuthResolver: () => PendingAuthSession | null = () => null;

  configure(opts: {
    clientsStore?: OAuthRegisteredClientsStore;
    authCodesStore?: AuthCodesStore;
    refreshJtiStore?: JtiStore;
    resolvePendingAuth?: () => PendingAuthSession | null;
  }): void {
    if (opts.clientsStore) this.clientsStoreImpl = opts.clientsStore;
    if (opts.authCodesStore) this.authCodesImpl = opts.authCodesStore;
    if (opts.refreshJtiStore) this.refreshJtiStoreImpl = opts.refreshJtiStore;
    if (opts.resolvePendingAuth) this.pendingAuthResolver = opts.resolvePendingAuth;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clientsStoreImpl;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = crypto.randomBytes(32).toString("hex");
    const pending = this.pendingAuthResolver();

    await this.authCodesImpl.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      fbUserId: pending?.fbUserId,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    logger.info(
      { clientId: client.client_id, fbUserId: pending?.fbUserId ?? null },
      "Authorization code issued",
    );
    res.redirect(302, redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = await this.authCodesImpl.get(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.authCodesImpl.delete(authorizationCode);
      throw new Error("Authorization code has expired");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // Atomic get-and-delete: under concurrent exchange requests, only the
    // first caller sees the entry. RFC 6749 §10.5: codes must be single-use.
    const entry = await this.authCodesImpl.consume(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }

    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("Authorization code has expired");
    }

    // Defense-in-depth PKCE check. mcp-sdk's primary verification happens
    // upstream via challengeForAuthorizationCode; we re-verify here when
    // the verifier is supplied so the guarantee survives any future
    // change in how mcp-sdk wires the calls. We don't *require* the
    // verifier in this method (the SDK's flow sometimes passes it,
    // sometimes hands the challenge upward), but if it's present it must
    // match.
    if (entry.codeChallenge && codeVerifier) {
      const computed = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (computed !== entry.codeChallenge) {
        throw new Error("PKCE verification failed");
      }
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource:
        resource ?? (entry.resource ? new URL(entry.resource) : undefined),
      fbUserId: entry.fbUserId,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const secret = getJwtSecret();

    const { payload } = await jwtVerify(refreshToken, secret).catch(() => {
      throw new Error("Invalid refresh token");
    });

    if (payload.type !== "refresh") {
      throw new Error("Token is not a refresh token");
    }
    if (payload.sub !== client.client_id) {
      throw new Error("Refresh token was issued to a different client");
    }
    // jti must be present in the allow-list — i.e. issued by us, not yet
    // revoked, and not yet rotated. Old tokens issued before this code
    // existed don't carry a jti and would be rejected here, which is the
    // intended behaviour after rolling out the change.
    const jti = typeof payload.jti === "string" ? payload.jti : null;
    if (!jti) {
      throw new Error("Refresh token missing jti");
    }
    // Atomic consume: under concurrent refresh requests with the same
    // token, only one wins. Without this, has()+delete() were two
    // separate calls, leaving a replay window across instances backed by
    // Firestore (and breaking the rotation guarantee in-memory under
    // sufficient async interleaving). Even if generateTokens fails after
    // this, the worst case is the user has to re-authorize.
    if (!(await this.refreshJtiStoreImpl.consume(jti))) {
      throw new Error("Refresh token has been revoked or already used");
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource,
      fbUserId:
        typeof payload.fb_user_id === "string" ? payload.fb_user_id : undefined,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const secret = getJwtSecret();

    const { payload } = await jwtVerify(token, secret).catch(() => {
      throw new Error("Invalid access token");
    });

    if (payload.type !== "access") {
      throw new Error("Token is not an access token");
    }

    const extra: Record<string, unknown> = {};
    if (typeof payload.fb_user_id === "string") {
      extra.fbUserId = payload.fb_user_id;
    }

    const authInfo: AuthInfo = {
      token,
      clientId: payload.sub!,
      scopes: [],
      expiresAt: payload.exp,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
    if (payload.resource) {
      authInfo.resource = new URL(payload.resource as string);
    }
    return authInfo;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // RFC 7009: best-effort revoke. We can only revoke refresh tokens (the
    // ones we track jtis for). Access tokens are 1h TTL and stateless.
    const token = request.token;
    if (!token) return;
    try {
      const { payload } = await jwtVerify(token, getJwtSecret());
      if (payload.type === "refresh" && typeof payload.jti === "string") {
        await this.refreshJtiStoreImpl.delete(payload.jti);
        logger.info({ jti: payload.jti }, "Refresh token revoked");
      }
    } catch {
      // Silently ignore — RFC 7009 §2.2: revocation responses must succeed
      // even on unrecognised tokens.
    }
  }

  private async generateTokens(input: {
    clientId: string;
    resource?: URL;
    fbUserId?: string;
  }): Promise<OAuthTokens> {
    const secret = getJwtSecret();
    const now = Math.floor(Date.now() / 1000);

    const claims: Record<string, unknown> = {
      sub: input.clientId,
      type: "access",
    };
    if (input.resource) claims.resource = input.resource.href;
    if (input.fbUserId) claims.fb_user_id = input.fbUserId;

    const accessToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);

    // Refresh tokens carry a jti recorded in the refresh allow-list.
    // Exchange-refresh deletes the jti before minting a new pair (rotation),
    // and revokeToken can wipe it on demand.
    const refreshJti = crypto.randomBytes(16).toString("hex");
    const refreshExpiresAt = now + 30 * 24 * 3600;
    const refreshClaims: Record<string, unknown> = {
      sub: input.clientId,
      type: "refresh",
      jti: refreshJti,
    };
    if (input.fbUserId) refreshClaims.fb_user_id = input.fbUserId;

    const refreshToken = await new SignJWT(refreshClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(refreshExpiresAt)
      .sign(secret);

    await this.refreshJtiStoreImpl.put(refreshJti, {
      expiresAt: refreshExpiresAt,
      meta: {
        clientId: input.clientId,
        fbUserId: input.fbUserId ?? null,
      },
    });

    logger.info(
      { clientId: input.clientId, fbUserId: input.fbUserId ?? null },
      "Tokens issued",
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }
}

export const oauthProvider: MetaAdsOAuthProvider = new MetaAdsOAuthProvider();

export function resetOAuthProviderForTests(): void {
  cachedSecret = undefined;
  oauthProvider.configure({
    clientsStore: new InMemoryClientsStore(),
    authCodesStore: new InMemoryAuthCodesStore(),
    refreshJtiStore: new InMemoryJtiStore(),
    resolvePendingAuth: () => null,
  });
}
