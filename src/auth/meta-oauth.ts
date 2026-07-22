import { logger } from "../utils/logger.js";

const META_API_VERSION = process.env.META_API_VERSION ?? "v22.0";
const META_GRAPH = "https://graph.facebook.com";
const META_OAUTH_DIALOG = "https://www.facebook.com";

const DEFAULT_SCOPES = [
  "ads_management",
  "ads_read",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "whatsapp_business_management",
  "email",
  "public_profile",
];

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  apiVersion: string;
}

export function loadMetaOAuthConfig(serverUrl: URL): MetaOAuthConfig | null {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;

  const redirectUri =
    process.env.META_OAUTH_REDIRECT_URI?.trim() ||
    new URL("/auth/meta/callback", serverUrl).toString();

  return {
    appId,
    appSecret,
    redirectUri,
    apiVersion: META_API_VERSION,
  };
}

export function buildAuthorizeUrl(
  config: MetaOAuthConfig,
  state: string,
): string {
  const url = new URL(`/${config.apiVersion}/dialog/oauth`, META_OAUTH_DIALOG);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", DEFAULT_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}

export interface ShortLivedToken {
  accessToken: string;
  expiresIn: number | null;
}

export async function exchangeCodeForToken(
  config: MetaOAuthConfig,
  code: string,
): Promise<ShortLivedToken> {
  const url = new URL(`/${config.apiVersion}/oauth/access_token`, META_GRAPH);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    const message =
      typeof body.error === "object" && body.error && "message" in body.error
        ? String((body.error as { message?: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`Meta code exchange failed: ${message}`);
  }

  return {
    accessToken: String(body.access_token),
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
  };
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: number;
}

export async function exchangeForLongLivedToken(
  config: MetaOAuthConfig,
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const url = new URL(`/${config.apiVersion}/oauth/access_token`, META_GRAPH);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appSecret);
  url.searchParams.set("fb_exchange_token", shortLivedToken);

  const response = await fetch(url.toString());
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    const message =
      typeof body.error === "object" && body.error && "message" in body.error
        ? String((body.error as { message?: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`Meta long-lived swap failed: ${message}`);
  }

  const accessToken = String(body.access_token);
  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : 60 * 24 * 60 * 60;

  return {
    accessToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

export interface MetaProfile {
  id: string;
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
}

export async function fetchProfile(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<MetaProfile> {
  const url = new URL(`/${apiVersion}/me`, META_GRAPH);
  url.searchParams.set(
    "fields",
    "id,name,email,picture.width(200).height(200)",
  );
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const body = (await response.json()) as Record<string, unknown>;

  if (!response.ok || body.error) {
    const message =
      typeof body.error === "object" && body.error && "message" in body.error
        ? String((body.error as { message?: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`Meta /me fetch failed: ${message}`);
  }

  let pictureUrl: string | null = null;
  const pic = body.picture;
  if (pic && typeof pic === "object" && "data" in pic) {
    const data = (pic as { data?: { url?: unknown } }).data;
    if (data && typeof data.url === "string") {
      pictureUrl = data.url;
    }
  }

  return {
    id: String(body.id),
    name: typeof body.name === "string" ? body.name : null,
    email: typeof body.email === "string" ? body.email : null,
    pictureUrl,
  };
}

export async function validateToken(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<{ valid: boolean; profile?: MetaProfile; error?: string }> {
  try {
    const profile = await fetchProfile(accessToken, apiVersion);
    return { valid: true, profile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, "Meta token validation failed");
    return { valid: false, error: message };
  }
}

export interface MetaBusiness {
  id: string;
  name: string | null;
}

export async function fetchPrimaryBusiness(
  accessToken: string,
  apiVersion: string = META_API_VERSION,
): Promise<MetaBusiness | null> {
  const url = new URL(`/${apiVersion}/me/businesses`, META_GRAPH);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("limit", "1");
  url.searchParams.set("access_token", accessToken);

  try {
    const response = await fetch(url.toString());
    const body = (await response.json()) as Record<string, unknown>;

    if (!response.ok || body.error) {
      const message =
        typeof body.error === "object" && body.error && "message" in body.error
          ? String((body.error as { message?: unknown }).message)
          : `HTTP ${response.status}`;
      logger.warn({ error: message }, "Meta /me/businesses fetch failed");
      return null;
    }

    const data = Array.isArray(body.data) ? body.data : [];
    const first = data[0];
    if (!first || typeof first !== "object") return null;
    const id = (first as { id?: unknown }).id;
    if (typeof id !== "string") return null;
    const name = (first as { name?: unknown }).name;
    return {
      id,
      name: typeof name === "string" ? name : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, "Meta /me/businesses fetch threw");
    return null;
  }
}
