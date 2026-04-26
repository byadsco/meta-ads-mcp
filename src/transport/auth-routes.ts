import express from "express";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchPrimaryBusiness,
  fetchProfile,
  loadMetaOAuthConfig,
  validateToken,
  type MetaOAuthConfig,
} from "../auth/meta-oauth.js";
import { isAllowed } from "../auth/email-allowlist.js";
import { clearSession, getSession, setSession } from "../auth/session.js";
import {
  generateOAuthStateNonce,
  signOAuthState,
  verifyOAuthState,
} from "../auth/oauth-state.js";
import {
  deleteToken,
  getDefaultTokenName,
  saveToken,
  setDefaultToken,
  upsertUser,
} from "../store/meta-token-repo.js";
import { logger } from "../utils/logger.js";
import { hashPii } from "../auth/token-store.js";

const OAUTH_STATE_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-meta_oauth_state" : "meta_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Sanitize a returnTo URL provided by callers (?return=… on /auth/meta).
 *
 * Defenses (CODE-M3):
 *   - must start with a single "/" (no scheme, no protocol-relative "//")
 *   - max length 2048 (avoid header smuggling and absurdly large redirects)
 *   - control characters (CR, LF, NUL, etc.) rejected — prevents response
 *     splitting / header injection if this ever ends up in a Location header
 *     unencoded by a downstream proxy
 *   - if it points at /authorize, the query must carry both client_id and
 *     redirect_uri (otherwise it's the same dead-end the validation gate
 *     guards against, just reached via a redirect chain)
 *
 * On any failure, fall back to "/authorize" — the landing page handles
 * unauthenticated users.
 */
export function safeReturnTo(input: unknown): string {
  if (typeof input !== "string") return "/authorize";
  if (input.length === 0 || input.length > 2048) return "/authorize";
  if (!input.startsWith("/")) return "/authorize";
  if (input.startsWith("//")) return "/authorize";
  // Reject control characters (0x00–0x1f and DEL).
  if (/[\x00-\x1f\x7f]/.test(input)) return "/authorize";

  // If returnTo points at /authorize, make sure it has the OAuth params
  // the GET handler now requires. A path like "/authorize" alone is
  // valid and renders the landing page; anything matching "/authorize?…"
  // must carry both client_id and redirect_uri.
  if (input === "/authorize" || input.startsWith("/authorize?")) {
    const qIdx = input.indexOf("?");
    if (qIdx === -1) return input; // bare /authorize → landing page is fine
    const params = new URLSearchParams(input.slice(qIdx + 1));
    if (!params.get("client_id") || !params.get("redirect_uri")) {
      return "/authorize";
    }
  }
  return input;
}

function renderError(res: express.Response, status: number, message: string): void {
  // Restrictive CSP on every server-rendered HTML page (CODE-B3): even
  // though renderError only emits inline <style>, pinning the policy
  // limits the blast radius if user-controlled content ever leaks
  // through escapeHtml in the future.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  res.status(status).type("html").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth error</title>
    <style>body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2.5rem;max-width:420px;text-align:center}
    h1{color:#fca5a5;margin:0 0 0.5rem}p{color:#aaa;margin:0}</style></head>
    <body><div class="card"><h1>Auth error</h1><p>${escapeHtml(message)}</p></div></body></html>`,
  );
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function setOAuthStateCookie(res: express.Response, nonce: string): void {
  res.cookie(OAUTH_STATE_COOKIE_NAME, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_TTL_MS,
    path: "/",
  });
}

function getOAuthStateCookie(req: express.Request): string | null {
  const reqCookies = (req as express.Request & { cookies?: Record<string, string> })
    .cookies;
  const nonce = reqCookies?.[OAUTH_STATE_COOKIE_NAME];
  return typeof nonce === "string" && nonce.length > 0 ? nonce : null;
}

function clearOAuthStateCookie(res: express.Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export interface AuthRoutesOptions {
  serverUrl: URL;
}

function getMetaConfigOr500(
  serverUrl: URL,
  res: express.Response,
): MetaOAuthConfig | null {
  const config = loadMetaOAuthConfig(serverUrl);
  if (!config) {
    renderError(res, 500, "Meta OAuth is not configured on this server.");
    return null;
  }
  return config;
}

export function mountAuthRoutes(
  app: express.Application,
  options: AuthRoutesOptions,
): void {
  const { serverUrl } = options;

  app.get("/auth/meta", async (req, res) => {
    const config = getMetaConfigOr500(serverUrl, res);
    if (!config) return;

    const returnTo = safeReturnTo(
      typeof req.query.return === "string" ? req.query.return : req.originalUrl,
    );
    const nonce = generateOAuthStateNonce();
    const state = await signOAuthState({ returnTo, nonce });
    setOAuthStateCookie(res, nonce);

    res.redirect(302, buildAuthorizeUrl(config, state));
  });

  app.get("/auth/meta/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const stateNonce = getOAuthStateCookie(req);
    clearOAuthStateCookie(res);

    const config = getMetaConfigOr500(serverUrl, res);
    if (!config) return;

    if (error) {
      // Don't reflect Meta's error code/message back to the user — log it
      // server-side and show a generic message (CODE-M1).
      logger.warn(
        {
          metaError: error,
          metaErrorCode: req.query.error_code,
          metaErrorReason: req.query.error_reason,
          metaErrorDescription: req.query.error_description,
        },
        "Meta OAuth callback returned an error",
      );
      renderError(
        res,
        400,
        "Login was cancelled or rejected by Meta. Please try again.",
      );
      return;
    }
    if (!code || !state) {
      renderError(res, 400, "Missing code or state in callback.");
      return;
    }

    const pending = stateNonce ? await verifyOAuthState(state, stateNonce) : null;
    if (!pending) {
      renderError(res, 400, "Invalid or expired OAuth state.");
      return;
    }

    try {
      const shortLived = await exchangeCodeForToken(config, code);
      const longLived = await exchangeForLongLivedToken(
        config,
        shortLived.accessToken,
      );
      const profile = await fetchProfile(longLived.accessToken, config.apiVersion);

      if (!isAllowed({ email: profile.email, fbUserId: profile.id })) {
        // Hash PII before logging — keeps the value correlatable across
        // events without persisting the raw email/fbUserId in log
        // retention (CODE-B5).
        logger.warn(
          { fbUserId: hashPii(profile.id), email: hashPii(profile.email) },
          "Meta login rejected by allowlist",
        );
        renderError(
          res,
          403,
          "This Meta account is not allowed to use this server. Contact the administrator.",
        );
        return;
      }

      const business = await fetchPrimaryBusiness(
        longLived.accessToken,
        config.apiVersion,
      );

      await upsertUser(profile.id, profile);
      await saveToken({
        fbUserId: profile.id,
        name: "personal",
        accessToken: longLived.accessToken,
        kind: "user",
        expiresAt: longLived.expiresAt,
        metaUserId: profile.id,
        metaUserName: profile.name,
        businessId: business?.id ?? null,
        businessName: business?.name ?? null,
        setAsDefault: !(await getDefaultTokenName(profile.id)),
      });

      await setSession(res, {
        fbUserId: profile.id,
        email: profile.email,
        name: profile.name,
      });

      res.redirect(302, safeReturnTo(pending.returnTo));
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Meta callback failed",
      );
      renderError(res, 500, "Login failed. Please try again.");
    }
  });

  app.post("/auth/logout", async (req, res) => {
    await clearSession(req, res);
    res.redirect(302, "/authorize");
  });

  app.post(
    "/auth/select-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const session = await getSession(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const name = typeof req.body?.name === "string" ? req.body.name : null;
      if (!name) {
        res.status(400).json({ error: "Missing name" });
        return;
      }
      const ok = await setDefaultToken(session.fbUserId, name);
      if (!ok) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const returnTo = safeReturnTo(req.body?.return);
      res.redirect(302, returnTo);
    },
  );

  app.post(
    "/auth/register-system-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const session = await getSession(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      const token =
        typeof req.body?.access_token === "string"
          ? req.body.access_token.trim()
          : "";

      if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
        renderError(res, 400, "Invalid token name (1-64 chars: a-z, A-Z, 0-9, _, -).");
        return;
      }
      if (!token || token.length < 10) {
        renderError(res, 400, "Invalid access token.");
        return;
      }

      const validation = await validateToken(token);
      if (!validation.valid || !validation.profile) {
        // Don't echo Meta's validation error verbatim — it can carry
        // trace IDs and Graph API messages we don't want surfaced to
        // the operator's UI (CODE-M1).
        logger.warn(
          {
            fbUserId: hashPii(session.fbUserId),
            tokenName: name,
            error: validation.error ?? null,
          },
          "System User token validation failed",
        );
        renderError(
          res,
          400,
          "Token validation failed. The token may be expired, revoked, or for a different Meta app. Check the server logs for details.",
        );
        return;
      }

      const business = await fetchPrimaryBusiness(token);

      await saveToken({
        fbUserId: session.fbUserId,
        name,
        accessToken: token,
        kind: "system_user",
        expiresAt: null,
        metaUserId: validation.profile.id,
        metaUserName: validation.profile.name,
        businessId: business?.id ?? null,
        businessName: business?.name ?? null,
      });

      const returnTo = safeReturnTo(req.body?.return);
      res.redirect(302, returnTo);
    },
  );

  app.post(
    "/auth/delete-token",
    express.urlencoded({ extended: false }),
    async (req, res) => {
      const session = await getSession(req);
      if (!session) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }
      const name = typeof req.body?.name === "string" ? req.body.name : null;
      if (!name) {
        res.status(400).json({ error: "Missing name" });
        return;
      }
      const ok = await deleteToken(session.fbUserId, name);
      if (!ok) {
        res.status(404).json({ error: "Token not found" });
        return;
      }
      const returnTo = safeReturnTo(req.body?.return);
      res.redirect(302, returnTo);
    },
  );
}
