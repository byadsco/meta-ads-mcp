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

// ── JWT Secret ──────────────────────────────────────────────

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

// ── Auth Code Store ─────────────────────────────────────────

interface AuthCodeEntry {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
  expiresAt: number;
}

// ── Clients Store ───────────────────────────────────────────

const MAX_REGISTERED_CLIENTS = 100;

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    // Prevent unbounded client registration (DoS protection)
    if (this.clients.size >= MAX_REGISTERED_CLIENTS && !this.clients.has(client.client_id)) {
      throw new Error("Maximum number of registered clients reached");
    }
    this.clients.set(client.client_id, client);
    logger.info(
      { clientId: client.client_id, clientName: client.client_name },
      "Registered OAuth client",
    );
    return client;
  }
}

// ── OAuth Server Provider ───────────────────────────────────

const AUTH_CODE_MAX = 50;

export class MetaAdsOAuthProvider implements OAuthServerProvider {
  private readonly _clientsStore = new InMemoryClientsStore();
  private readonly authCodes = new Map<string, AuthCodeEntry>();

  constructor() {
    // Clean expired auth codes every 5 minutes to prevent memory leaks
    setInterval(() => this.cleanExpiredCodes(), 5 * 60 * 1000).unref();
  }

  private cleanExpiredCodes(): void {
    const now = Math.floor(Date.now() / 1000);
    let cleaned = 0;
    for (const [code, entry] of this.authCodes) {
      if (entry.expiresAt < now) {
        this.authCodes.delete(code);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned }, "Cleaned expired authorization codes");
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Prevent memory exhaustion from too many pending auth codes
    if (this.authCodes.size >= AUTH_CODE_MAX) {
      this.cleanExpiredCodes();
    }
    if (this.authCodes.size >= AUTH_CODE_MAX) {
      throw new Error("Too many pending authorization requests");
    }

    const code = crypto.randomBytes(32).toString("hex");

    this.authCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource,
      expiresAt: Math.floor(Date.now() / 1000) + 600, // 10 minutes
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    logger.info({ clientId: client.client_id }, "Authorization code issued");
    res.redirect(302, redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      this.authCodes.delete(authorizationCode);
      throw new Error("Authorization code has expired");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }

    // Consume code (one-time use)
    this.authCodes.delete(authorizationCode);

    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("Authorization code has expired");
    }

    return this.generateTokens(client.client_id, resource);
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

    return this.generateTokens(client.client_id, resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const secret = getJwtSecret();

    const { payload } = await jwtVerify(token, secret).catch(() => {
      throw new Error("Invalid access token");
    });

    if (payload.type !== "access") {
      throw new Error("Token is not an access token");
    }

    const authInfo: AuthInfo = {
      token,
      clientId: payload.sub!,
      scopes: [],
      expiresAt: payload.exp,
    };
    if (payload.resource) {
      authInfo.resource = new URL(payload.resource as string);
    }
    return authInfo;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // JWTs are stateless — revocation is a no-op (token expires naturally)
    logger.debug("Token revocation requested (no-op for stateless JWTs)");
  }

  // ── Internal helpers ────────────────────────────────────

  private async generateTokens(clientId: string, resource?: URL): Promise<OAuthTokens> {
    const secret = getJwtSecret();
    const now = Math.floor(Date.now() / 1000);

    const accessToken = await new SignJWT({
      sub: clientId,
      type: "access",
      ...(resource && { resource: resource.href }),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600) // 1 hour
      .sign(secret);

    const refreshToken = await new SignJWT({
      sub: clientId,
      type: "refresh",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 30 * 24 * 3600) // 30 days
      .sign(secret);

    logger.info({ clientId }, "Tokens issued");

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }
}

export const oauthProvider = new MetaAdsOAuthProvider();
