import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider } from "../auth/oauth-provider.js";
import { isApiKeyConfigured, validateApiKey } from "../auth/api-key.js";
import { hashPii, requestContext } from "../auth/token-store.js";
import { tokenManager } from "../auth/token-manager.js";
import { configureSessionJtiStore, getSession } from "../auth/session.js";
import { resolveSecurityConfig } from "./security-config.js";
import { mountAuthRoutes, safeReturnTo } from "./auth-routes.js";
import { escapeHtml } from "../utils/html.js";
import {
  CONNECTIONS_PATH,
  PAGE_STYLES,
  renderApifySection,
  userInitials,
} from "./html-pages.js";
import { getApifyTokenRepo } from "../store/apify-token-repo.js";
import type { ApifyTokenStatus } from "../store/apify-token-repo.js";

import { validateAuthorizeQuery } from "./authorize-validation.js";
import {
  FirestoreClientsStore,
  InMemoryClientsStore,
} from "../store/persistent-clients-store.js";
import {
  FirestoreAuthCodesStore,
  InMemoryAuthCodesStore,
} from "../store/persistent-auth-codes.js";
import {
  FirestoreJtiStore,
  InMemoryJtiStore,
} from "../store/persistent-jti-store.js";
import {
  configureMetaTokenRepo,
  FirestoreMetaTokenRepo,
  InMemoryMetaTokenRepo,
  getDecryptedToken,
  getDefaultTokenName,
  listTokens,
  setDefaultToken,
} from "../store/meta-token-repo.js";
import { isFirestoreEnabled } from "../store/firestore.js";
import { logger } from "../utils/logger.js";
import { unsafeIpReason } from "../utils/url-guard.js";

interface PendingAuth {
  fbUserId: string;
}

const pendingAuthStorage = new AsyncLocalStorage<PendingAuth>();

/** Rendered when the Apify status cannot be read — the section degrades, OAuth continues. */
const UNKNOWN_APIFY_STATUS: ApifyTokenStatus = {
  registered: false,
  apifyUserId: null,
  apifyUsername: null,
  updatedAt: null,
};

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function getServerUrl(): URL {
  const envUrl = process.env.SERVER_URL;
  if (envUrl) {
    let parsed: URL;
    try {
      parsed = new URL(envUrl);
    } catch {
      throw new Error(`SERVER_URL is not a valid URL: ${envUrl}`);
    }
    // Defensive constraints (CODE-B7): SERVER_URL is used to build OAuth
    // redirect URIs and the Meta callback URL. A poisoned value would
    // redirect the OAuth dance to an attacker host. In production we
    // require https:// and reject hostname-less or port-only values.
    if (process.env.NODE_ENV === "production") {
      if (parsed.protocol !== "https:") {
        throw new Error(
          `SERVER_URL must use https:// in production, got: ${parsed.protocol}`,
        );
      }
      if (!parsed.hostname || parsed.hostname === "localhost") {
        throw new Error(
          `SERVER_URL must point at a real hostname in production, got: ${parsed.hostname || "(empty)"}`,
        );
      }
      const host = normalizeHostname(parsed.hostname);
      if (isIP(host) && unsafeIpReason(host)) {
        throw new Error(
          `SERVER_URL must point at a public hostname or IP in production, got private IP: ${host}`,
        );
      }
    }
    return parsed;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("SERVER_URL environment variable is required in production");
  }
  const port = process.env.PORT || "3000";
  return new URL(`http://localhost:${port}`);
}

export function healthPayload(): { status: "ok" } {
  return { status: "ok" };
}

interface ConsentContext {
  query: Record<string, string>;
  user: { fbUserId: string; email: string | null; name: string | null };
  tokens: Awaited<ReturnType<typeof listTokens>>;
  activeName: string | null;
  apify: ApifyTokenStatus;
}

export function renderConsentPage(ctx: ConsentContext): string {
  const clientId = escapeHtml(ctx.query.client_id || "Unknown");
  const hiddenFields = Object.entries(ctx.query)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n        ");

  const fullPath = "/authorize?" + new URLSearchParams(ctx.query).toString();
  const returnHidden = `<input type="hidden" name="return" value="${escapeHtml(fullPath)}" />`;

  const tokenOptions =
    ctx.tokens.length > 0
      ? ctx.tokens
          .map((t) => {
            const checked = t.name === ctx.activeName ? "checked" : "";
            const expiry =
              t.kind === "system_user"
                ? "no expira"
                : t.expiresAt
                  ? `${Math.max(0, Math.ceil((t.expiresAt - Date.now() / 1000) / 86400))} días`
                  : "—";
            const expired = t.isExpired
              ? '<span class="badge badge-warn">expirado</span>'
              : "";
            const kind = t.kind === "system_user" ? "system" : "personal";
            const businessChip = t.businessName
              ? `<span class="badge badge-bm" title="Business Manager">${escapeHtml(t.businessName)}</span>`
              : "";
            return `<label class="token-row${t.name === ctx.activeName ? " active" : ""}">
              <input type="radio" name="token" value="${escapeHtml(t.name)}" ${checked} form="approve-form" />
              <span class="token-name">${escapeHtml(t.name)}</span>
              <span class="badge">${kind}</span>
              ${businessChip}
              ${expired}
              <span class="token-expiry">${expiry}</span>
            </label>`;
          })
          .join("\n")
      : `<p class="no-tokens">No hay tokens conectados. Pega un System User token abajo o cierra sesión y vuelve a iniciar.</p>`;

  const initials = userInitials(ctx.user);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Autorizar — Meta Ads MCP</title>
  <style>
${PAGE_STYLES}
  </style>
</head>
<body>
  <div class="card">
    <div class="user">
      <div class="avatar">${escapeHtml(initials || "U")}</div>
      <div class="user-info">
        <div class="user-name">${escapeHtml(ctx.user.name ?? "Usuario Meta")}</div>
        <div class="user-email">${escapeHtml(ctx.user.email ?? ctx.user.fbUserId)}</div>
      </div>
      <form method="POST" action="/auth/logout" class="inline">
        <button type="submit" class="logout">Salir</button>
      </form>
    </div>

    <h1>Autorizar Meta Ads MCP</h1>
    <p class="subtitle">
      <span class="client">${clientId}</span> quiere acceder a tu servidor Meta Ads MCP.
    </p>

    <div class="section">
      <div class="section-title">Permisos solicitados</div>
      <ul class="permissions">
        <li>• Leer y gestionar cuentas publicitarias de Meta</li>
        <li>• Crear, actualizar y pausar campañas</li>
        <li>• Acceder a reportes e insights</li>
        <li>• Gestionar WhatsApp Business (números, plantillas, flows)</li>
      </ul>
    </div>

    <div class="section">
      <div class="section-title">Token activo de Meta</div>
      ${tokenOptions}
    </div>

    <details>
      <summary>Registrar System User token (no caduca)</summary>
      <form method="POST" action="/auth/register-system-token">
        ${returnHidden}
        <input type="text" name="name" placeholder="Nombre (ej. byads, client_acme)" required maxlength="64" pattern="[a-zA-Z0-9_-]{1,64}" />
        <input type="password" name="access_token" placeholder="Pega el System User access token" required minlength="10" autocomplete="off" />
        <button type="submit">Validar y guardar</button>
      </form>
    </details>

    ${renderApifySection({ status: ctx.apify, returnTo: fullPath, variant: "consent" })}

    <a class="manage-link" href="${CONNECTIONS_PATH}">Gestionar conexiones →</a>

    <form id="approve-form" method="POST" action="/authorize">
      ${hiddenFields}
      <button type="submit" class="approve" ${ctx.tokens.length === 0 ? "disabled" : ""}>
        ${ctx.tokens.length === 0 ? "Conecta un token primero" : "Aprobar"}
      </button>
    </form>
    <form method="GET" action="${escapeHtml(ctx.query.redirect_uri || "/")}">
      <input type="hidden" name="error" value="access_denied" />
      ${ctx.query.state ? `<input type="hidden" name="state" value="${escapeHtml(ctx.query.state)}" />` : ""}
      <button type="submit" class="deny">Denegar</button>
    </form>
  </div>
</body>
</html>`;
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const requests = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of requests) {
      if (entry.resetAt < now) requests.delete(ip);
    }
  }, windowMs).unref();

  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const entry = requests.get(ip);

    if (!entry || entry.resetAt < now) {
      requests.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxRequests) {
      logger.warn({ ip, path: req.path }, "Rate limit exceeded");
      res.status(429).json({ error: "Too many requests, please try again later" });
      return;
    }

    next();
  };
}

function extractApiKey(req: express.Request): string | undefined {
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) return xApiKey;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return undefined;
}

function createCombinedAuthMiddleware(
  oauthMiddleware: express.RequestHandler,
): express.RequestHandler {
  return (req, res, next) => {
    if (!isApiKeyConfigured()) {
      oauthMiddleware(req, res, next);
      return;
    }

    const xApiKey = req.headers["x-api-key"];
    if (typeof xApiKey === "string" && xApiKey) {
      if (validateApiKey(xApiKey)) {
        logger.debug("Authenticated via X-API-Key header");
        next();
        return;
      }
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid API key" },
        id: null,
      });
      return;
    }

    const candidate = extractApiKey(req);
    if (candidate && validateApiKey(candidate)) {
      logger.debug("Authenticated via Bearer token (API key match)");
      next();
      return;
    }

    oauthMiddleware(req, res, next);
  };
}

function buildMetaTokenMiddleware(
  serverUrl: URL,
  multiTenantEnabled: boolean,
): express.RequestHandler {
  return async (req, res, next) => {
    const headerToken = req.headers["x-meta-token"];
    if (typeof headerToken === "string" && headerToken) {
      requestContext.run({ accessToken: headerToken }, () => next());
      return;
    }

    const auth = (req as express.Request & {
      auth?: { extra?: Record<string, unknown> };
    }).auth;
    const fbUserId =
      typeof auth?.extra?.fbUserId === "string" ? auth.extra.fbUserId : undefined;

    if (multiTenantEnabled && fbUserId) {
      try {
        const accessToken = await getDecryptedToken(
          fbUserId,
          undefined,
          serverUrl,
        );
        requestContext.run(
          { accessToken, fbUserId },
          () => next(),
        );
        return;
      } catch (err) {
        logger.warn(
          {
            fbUserId,
            error: err instanceof Error ? err.message : String(err),
          },
          "Failed to resolve user Meta token",
        );
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "No Meta token connected for this user. Please re-authenticate via /authorize.",
          },
          id: null,
        });
        return;
      }
    }

    const managerToken = tokenManager.getActiveToken();
    if (managerToken) {
      requestContext.run({ accessToken: managerToken }, () => next());
      return;
    }

    const envToken = process.env.META_ACCESS_TOKEN;
    if (envToken) {
      requestContext.run({ accessToken: envToken }, () => next());
      return;
    }

    logger.error("No Meta access token available for this request");
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message:
          "No Meta token configured. Connect via Meta OAuth, set META_ACCESS_TOKEN, or pass X-Meta-Token header.",
      },
      id: null,
    });
  };
}

export async function startHttpTransport(
  createServer: () => McpServer,
  port: number,
): Promise<void> {
  const app = express();
  const isProduction = process.env.NODE_ENV === "production";
  const config = resolveSecurityConfig();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // CORS: explicit allowlist instead of wildcard. The previous app.use(cors())
  // set Access-Control-Allow-Origin: * on every response, which let any origin
  // invoke /mcp with a stolen Bearer token. We only need cross-origin reads
  // for Claude.ai (and any operator-configured peers); /authorize and /auth/*
  // are top-level navigations that don't depend on CORS.
  const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS?.trim() || "https://claude.ai")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: corsAllowedOrigins,
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Meta-Token",
        "Mcp-Session-Id",
      ],
      maxAge: 600,
    }),
  );
  logger.info({ corsAllowedOrigins }, "CORS allowlist configured");
  app.use(cookieParser());
  app.use(express.json({ limit: "10mb" }));

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  if (isProduction) {
    app.use((req, res, next) => {
      if (req.header("x-forwarded-proto") !== "https") {
        res.redirect(301, `https://${req.header("host")}${req.originalUrl}`);
        return;
      }
      next();
    });
  }

  const serverUrl = getServerUrl();

  if (config.multiTenantEnabled) {
    if (!isFirestoreEnabled()) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "Multi-tenant Meta OAuth requires Firestore in production. Set FIRESTORE_PROJECT_ID or GOOGLE_CLOUD_PROJECT.",
        );
      }
      logger.warn(
        "Multi-tenant Meta OAuth enabled but Firestore is not configured (no FIRESTORE_PROJECT_ID/GOOGLE_CLOUD_PROJECT/FIRESTORE_EMULATOR_HOST). Falling back to in-memory stores — sessions and tokens will be lost on restart.",
      );
      oauthProvider.configure({
        clientsStore: new InMemoryClientsStore(),
        authCodesStore: new InMemoryAuthCodesStore(),
        refreshJtiStore: new InMemoryJtiStore(),
        resolvePendingAuth: () => pendingAuthStorage.getStore() ?? null,
      });
      configureSessionJtiStore(new InMemoryJtiStore());
      configureMetaTokenRepo(new InMemoryMetaTokenRepo());
    } else {
      oauthProvider.configure({
        clientsStore: new FirestoreClientsStore(),
        authCodesStore: new FirestoreAuthCodesStore(),
        refreshJtiStore: new FirestoreJtiStore("mcp_refresh_jti"),
        resolvePendingAuth: () => pendingAuthStorage.getStore() ?? null,
      });
      configureSessionJtiStore(new FirestoreJtiStore("mcp_session_jti"));
      configureMetaTokenRepo(new FirestoreMetaTokenRepo());
    }
  }

  app.get("/health", (_req, res) => {
    res.json(healthPayload());
  });

  if (config.multiTenantEnabled) {
    // Registered BEFORE mountAuthRoutes on purpose: Express matches in
    // registration order, so a limiter added after the route handler would
    // never run. Each POST makes an outbound api.apify.com call, which without
    // a cap turns the endpoint into a credential-validation oracle against a
    // third party.
    app.use(
      "/auth/register-apify-token",
      createRateLimiter(10, 15 * 60 * 1000),
    );

    mountAuthRoutes(app, {
      serverUrl,
      getClient: (id) => oauthProvider.clientsStore.getClient(id),
    });

    app.get("/authorize", async (req, res) => {
      const query = req.query as Record<string, string>;

      // Validate client_id and redirect_uri BEFORE rendering the consent
      // page or kicking off the Meta login dance. mcp-sdk validates these
      // in POST /authorize but the GET handler used to reflect the value
      // verbatim into the "Deny" form action.
      const validation = await validateAuthorizeQuery(query, async (id) =>
        oauthProvider.clientsStore.getClient(id),
      );
      if (!validation.ok) {
        if (validation.kind === "no-params") {
          res.status(validation.status).type("html").send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invalid request</title>
            <style>body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem}
            .card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:2rem;max-width:480px;text-align:center}
            h1{color:#fff;margin:0 0 1rem;font-size:1.3rem}
            p{color:#aaa;margin:0.5rem 0;font-size:0.95rem;line-height:1.5}</style></head>
            <body><div class="card">
              <h1>Invalid request</h1>
              <p>${escapeHtml(validation.message)}</p>
            </div></body></html>`,
          );
          return;
        }
        logger.warn(
          { clientId: query.client_id, redirectUri: query.redirect_uri, kind: validation.kind, reason: validation.message },
          "Rejected /authorize",
        );
        res.status(validation.status).type("html").send(
          `<h1>Invalid request</h1><p>${escapeHtml(validation.message)}</p>`,
        );
        return;
      }
      const { redirectOrigin } = validation;

      const session = await getSession(req);
      if (!session) {
        const returnTo = req.originalUrl;
        res.redirect(302, `/auth/meta?return=${encodeURIComponent(returnTo)}`);
        return;
      }

      const [tokens, activeName, apify] = await Promise.all([
        listTokens(session.fbUserId),
        getDefaultTokenName(session.fbUserId),
        // Apify is an optional add-on, so a failure reading its status must not
        // take down OAuth approval. Degrade to "not connected" and log it.
        getApifyTokenRepo()
          .getStatus(session.fbUserId)
          .catch((error: unknown) => {
            logger.warn(
              {
                event: "apify_status_unavailable",
                fbUserId: hashPii(session.fbUserId),
                error: error instanceof Error ? error.message : String(error),
              },
              "Could not read Apify status; rendering consent without it",
            );
            return UNKNOWN_APIFY_STATUS;
          }),
      ]);

      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigin}`,
      );
      // The page renders token names, Business Manager names and the Apify
      // account — none of it belongs in a shared or back-button cache.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Cookie");

      res.type("html").send(
        renderConsentPage({
          query,
          user: {
            fbUserId: session.fbUserId,
            email: session.email,
            name: session.name,
          },
          tokens,
          activeName,
          apify,
        }),
      );
    });

    app.post(
      "/authorize",
      express.urlencoded({ extended: false }),
      async (req, res, next) => {
        const session = await getSession(req);
        if (!session) {
          const recoverTo = safeReturnTo(req.body?.return);
          const link =
            recoverTo === "/authorize"
              ? "Vuelve a iniciar la autorización desde tu cliente MCP."
              : `<a href="${escapeHtml(recoverTo)}">Inicia de nuevo</a>.`;
          res.status(401).type("html").send(`<p>Sesión expirada. ${link}</p>`);
          return;
        }

        let activeName: string | null = null;
        const requestedToken =
          typeof req.body?.token === "string" && req.body.token.length > 0
            ? req.body.token
            : null;
        if (requestedToken) {
          await setDefaultToken(session.fbUserId, requestedToken);
          activeName = requestedToken;
        } else {
          activeName = await getDefaultTokenName(session.fbUserId);
        }

        if (!activeName) {
          const recoverTo = safeReturnTo(req.body?.return);
          const link =
            recoverTo === "/authorize"
              ? "Vuelve a iniciar la autorización desde tu cliente MCP."
              : `Vuelve a <a href="${escapeHtml(recoverTo)}">/authorize</a>.`;
          res.status(400).type("html").send(
            `<p>No hay token de Meta conectado. ${link}</p>`,
          );
          return;
        }

        pendingAuthStorage.run({ fbUserId: session.fbUserId }, () => next());
      },
    );
  }

  app.use("/register", createRateLimiter(20, 15 * 60 * 1000));
  app.use("/token", createRateLimiter(60, 15 * 60 * 1000));

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: serverUrl,
      resourceServerUrl: new URL("/mcp", serverUrl),
    }),
  );

  const oauthBearerAuth = requireBearerAuth({ verifier: oauthProvider });
  const auth = createCombinedAuthMiddleware(oauthBearerAuth);
  const metaTokenMw = buildMetaTokenMiddleware(serverUrl, config.multiTenantEnabled);

  app.post("/mcp", auth, metaTokenMw, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);

      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (error) {
      logger.error({ error }, "Error handling MCP request");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "SSE not supported in stateless mode. Use POST." },
      id: null,
    });
  });

  app.delete("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session termination not applicable in stateless mode." },
      id: null,
    });
  });

  const authModes: string[] = [];
  if (isApiKeyConfigured()) authModes.push("API Key");
  authModes.push(config.multiTenantEnabled ? "Meta OAuth" : "OAuth 2.1");

  app.listen(port, () => {
    logger.info(
      {
        port,
        serverUrl: serverUrl.href,
        auth: authModes,
        multiTenant: config.multiTenantEnabled,
        firestore: isFirestoreEnabled(),
      },
      `Meta Ads MCP server listening (HTTP transport — auth: ${authModes.join(", ")})`,
    );
  });
}
