import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider } from "../auth/oauth-provider.js";
import { isApiKeyConfigured, validateApiKey } from "../auth/api-key.js";
import { requestContext } from "../auth/token-store.js";
import { tokenManager } from "../auth/token-manager.js";
import { logger } from "../utils/logger.js";

// ── Helpers ──────────────────────────────────────────────────

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function getServerUrl(): URL {
  const envUrl = process.env.SERVER_URL;
  if (envUrl) {
    return new URL(envUrl);
  }
  const port = process.env.PORT || "3000";
  return new URL(`http://localhost:${port}`);
}

interface ConsentPageOptions {
  error?: string;
  pinRequired?: boolean;
  rateLimited?: boolean;
}

function renderConsentPage(
  query: Record<string, string>,
  options: ConsentPageOptions = {},
): string {
  const clientId = escapeHtml(query.client_id || "Unknown");
  const hiddenFields = Object.entries(query)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n        ");

  const errorHtml = options.rateLimited
    ? `<div class="error">Too many failed attempts. Please try again later.</div>`
    : options.error
      ? `<div class="error">${escapeHtml(options.error)}</div>`
      : "";

  const pinFieldHtml = options.pinRequired
    ? `<div class="pin-group">
          <label for="approval_pin">Approval PIN</label>
          <input type="password" id="approval_pin" name="approval_pin"
                 placeholder="Enter PIN to approve" required autocomplete="off" />
        </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize — Meta Ads MCP</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center;
      align-items: center; min-height: 100vh; padding: 1rem; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px;
      padding: 2.5rem; max-width: 420px; width: 100%; text-align: center; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: #888; margin-bottom: 2rem; font-size: 0.95rem; }
    .client { color: #6cb4ee; font-weight: 600; }
    .permissions { text-align: left; background: #111; border-radius: 8px;
      padding: 1rem 1.25rem; margin-bottom: 2rem; }
    .permissions li { margin: 0.4rem 0; color: #aaa; font-size: 0.9rem; }
    .pin-group { text-align: left; margin-bottom: 1.5rem; }
    .pin-group label { display: block; color: #aaa; font-size: 0.85rem;
      margin-bottom: 0.4rem; }
    .pin-group input { width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #444;
      border-radius: 6px; background: #111; color: #e0e0e0; font-size: 1rem;
      outline: none; }
    .pin-group input:focus { border-color: #2563eb; }
    .error { background: #3b1111; border: 1px solid #7f1d1d; border-radius: 8px;
      padding: 0.75rem 1rem; margin-bottom: 1.25rem; color: #fca5a5;
      font-size: 0.9rem; text-align: left; }
    button { width: 100%; padding: 0.75rem; border: none; border-radius: 8px;
      font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .approve { background: #2563eb; color: #fff; margin-bottom: 0.75rem; }
    .approve:hover { background: #1d4ed8; }
    .deny { background: #333; color: #ccc; }
    .deny:hover { background: #444; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Meta Ads MCP</h1>
    <p class="subtitle">
      <span class="client">${clientId}</span> wants to access your Meta Ads MCP server.
    </p>
    <ul class="permissions">
      <li>Read and manage Meta ad accounts</li>
      <li>Create, update, and pause campaigns</li>
      <li>Access reporting and insights</li>
    </ul>
    ${errorHtml}
    <form method="POST" action="/authorize">
        ${hiddenFields}
        ${pinFieldHtml}
        <button type="submit" class="approve"${options.rateLimited ? " disabled" : ""}>Approve</button>
    </form>
    <form method="GET" action="${escapeHtml(query.redirect_uri || "/")}">
        <input type="hidden" name="error" value="access_denied" />
        ${query.state ? `<input type="hidden" name="state" value="${escapeHtml(query.state)}" />` : ""}
        <button type="submit" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>`;
}

// ── PIN authentication helpers ──────────────────────────────

interface RateLimitEntry {
  attempts: number;
  lockedUntil: number;
}

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const pinRateLimits = new Map<string, RateLimitEntry>();

/** Clean expired rate-limit entries every 15 minutes to prevent memory leaks. */
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pinRateLimits) {
    if (entry.lockedUntil > 0 && entry.lockedUntil < now) {
      pinRateLimits.delete(ip); // Lockout expired
    } else if (entry.lockedUntil === 0) {
      pinRateLimits.delete(ip); // Sub-threshold failures with no lockout
    }
  }
}, PIN_LOCKOUT_MS).unref();

function isPinRateLimited(ip: string): boolean {
  const entry = pinRateLimits.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  // Lockout expired — reset
  if (entry.attempts >= PIN_MAX_ATTEMPTS) {
    entry.attempts = 0;
    entry.lockedUntil = 0;
  }
  return false;
}

function recordPinFailure(ip: string): void {
  const entry = pinRateLimits.get(ip) ?? { attempts: 0, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= PIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
    logger.warn({ ip, attempts: entry.attempts }, "PIN rate limit lockout triggered");
  }
  pinRateLimits.set(ip, entry);
}

function resetPinFailures(ip: string): void {
  pinRateLimits.delete(ip);
}

function verifyPin(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  // Pad to equal length to avoid leaking length info via timing
  const maxLen = Math.max(a.length, b.length, 1);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);
  // Bitwise AND avoids short-circuit timing side-channel
  const contentMatch = crypto.timingSafeEqual(aPadded, bPadded) ? 1 : 0;
  const lengthMatch = a.length === b.length ? 1 : 0;
  return (contentMatch & lengthMatch) === 1;
}

// ── Generic endpoint rate limiter ────────────────────────────

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

// ── API Key auth middleware ──────────────────────────────────

/**
 * Extract an API key from the request, checking X-API-Key header first,
 * then falling back to Authorization: Bearer <token> if it matches
 * the configured MCP_API_KEY.
 */
function extractApiKey(req: express.Request): string | undefined {
  // Prefer explicit X-API-Key header
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey) {
    return xApiKey;
  }

  // Fall back to Bearer token if it matches the API key
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return undefined;
}

/**
 * Combined auth middleware that supports both API key and OAuth 2.1.
 *
 * When MCP_API_KEY is configured:
 *   - X-API-Key header → validate as API key
 *   - Bearer token that matches MCP_API_KEY → authenticate as API key
 *   - Bearer token that does NOT match → fall through to OAuth
 *
 * When MCP_API_KEY is NOT configured:
 *   - Always delegate to OAuth bearer auth
 */
function createCombinedAuthMiddleware(
  oauthMiddleware: express.RequestHandler,
): express.RequestHandler {
  return (req, res, next) => {
    // If API key auth is not configured, always use OAuth
    if (!isApiKeyConfigured()) {
      oauthMiddleware(req, res, next);
      return;
    }

    // Check X-API-Key header first (explicit API key)
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

    // Check Bearer token — could be API key or OAuth JWT
    const candidate = extractApiKey(req);
    if (candidate && validateApiKey(candidate)) {
      logger.debug("Authenticated via Bearer token (API key match)");
      next();
      return;
    }

    // Not an API key — delegate to OAuth
    oauthMiddleware(req, res, next);
  };
}

// ── Meta token middleware ────────────────────────────────────

/**
 * Resolves the Meta Graph API access token for the current request.
 *
 * Priority:
 *  1. X-Meta-Token header (per-request override)
 *  2. TokenManager active token (multi-token registry)
 *  3. META_ACCESS_TOKEN environment variable
 *
 * When only TokenManager has tokens (no header, no env var), the middleware
 * proceeds without setting request context — getAccessToken() will resolve
 * the token from TokenManager instead.
 */
function metaTokenMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const headerToken = req.headers["x-meta-token"];
  const metaToken =
    (typeof headerToken === "string" && headerToken) ||
    process.env.META_ACCESS_TOKEN;

  if (metaToken) {
    requestContext.run({ accessToken: metaToken }, () => {
      next();
    });
    return;
  }

  // TokenManager has tokens — proceed without context; getAccessToken()
  // will resolve the active token from the registry.
  if (tokenManager.hasTokens()) {
    next();
    return;
  }

  logger.error(
    "No Meta access token: set META_ACCESS_TOKEN or META_TOKENS env var, or pass X-Meta-Token header",
  );
  res.status(500).json({
    jsonrpc: "2.0",
    error: {
      code: -32603,
      message:
        "Server configuration error: Meta access token not configured. " +
        "Set META_ACCESS_TOKEN or META_TOKENS env var, or pass X-Meta-Token header.",
    },
    id: null,
  });
}

// ── Server startup ───────────────────────────────────────────

/**
 * Creates and starts an Express HTTP server with StreamableHTTP MCP transport.
 * Supports both OAuth 2.1 and API key authentication.
 */
export async function startHttpTransport(
  createServer: () => McpServer,
  port: number,
): Promise<void> {
  const app = express();
  const isProduction = process.env.NODE_ENV === "production";

  // Trust proxy (Cloud Run terminates TLS at the load balancer)
  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // ── Security headers (all responses) ─────────────────────
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ── HTTPS enforcement in production ──────────────────────
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
  const expectedPin = process.env.OAUTH_APPROVAL_PIN ?? "";
  const pinRequired = !!expectedPin;

  // Validate PIN strength in production
  if (isProduction && pinRequired && expectedPin.length < 4) {
    throw new Error("OAUTH_APPROVAL_PIN must be at least 4 characters in production");
  }

  // ── Health check (no auth) ──────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "meta-ads-mcp", version: "1.0.0" });
  });

  // ── Consent page (GET /authorize) ───────────────────────
  // Must be BEFORE mcpAuthRouter so our HTML page is served
  // instead of the SDK's GET handler.
  app.get("/authorize", (req, res) => {
    const query = req.query as Record<string, string>;
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    res.type("html").send(renderConsentPage(query, { pinRequired }));
  });

  // ── PIN validation for consent approval ─────────────────
  // Must be BEFORE mcpAuthRouter so the PIN is validated
  // before the SDK processes the authorization.
  if (pinRequired) {
    app.post(
      "/authorize",
      express.urlencoded({ extended: false }),
      (req, res, next) => {
        const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

        if (isPinRateLimited(ip)) {
          const { approval_pin: _, ...oauthParams } = req.body as Record<string, string>;
          res
            .status(429)
            .type("html")
            .send(renderConsentPage(oauthParams, { pinRequired: true, rateLimited: true }));
          return;
        }

        const providedPin = req.body?.approval_pin;
        if (
          !providedPin ||
          typeof providedPin !== "string" ||
          providedPin.length > 128 ||
          !verifyPin(providedPin, expectedPin)
        ) {
          recordPinFailure(ip);
          const { approval_pin: _, ...oauthParams } = req.body as Record<string, string>;
          logger.warn({ ip }, "Invalid approval PIN attempt");
          res
            .status(403)
            .type("html")
            .send(
              renderConsentPage(oauthParams, {
                pinRequired: true,
                error: "Invalid approval PIN. Please try again.",
              }),
            );
          return;
        }

        // PIN valid — reset failures and strip field before SDK sees it
        resetPinFailures(ip);
        delete req.body.approval_pin;
        next();
      },
    );
  }

  // ── Rate limiting on OAuth endpoints ───────────────────────
  app.use("/register", createRateLimiter(20, 15 * 60 * 1000)); // 20 per 15min per IP
  app.use("/token", createRateLimiter(60, 15 * 60 * 1000));    // 60 per 15min per IP

  // ── OAuth router (handles POST /authorize, /token, /register, /.well-known/*) ──
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: serverUrl,
      resourceServerUrl: new URL("/mcp", serverUrl),
    }),
  );

  // ── Auth middleware: API key + OAuth 2.1 ─────────────────
  const oauthBearerAuth = requireBearerAuth({ verifier: oauthProvider });
  const auth = createCombinedAuthMiddleware(oauthBearerAuth);

  // ── MCP endpoint — stateless mode ──────────────────────
  app.post("/mcp", auth, metaTokenMiddleware, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
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

  // Handle GET/DELETE for MCP (required by spec even in stateless mode)
  app.get("/mcp", auth, (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "SSE not supported in stateless mode. Use POST.",
      },
      id: null,
    });
  });

  app.delete("/mcp", auth, (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Session termination not applicable in stateless mode.",
      },
      id: null,
    });
  });

  // ── Start listening ─────────────────────────────────────
  const authModes: string[] = [];
  if (isApiKeyConfigured()) authModes.push("API Key");
  authModes.push("OAuth 2.1");

  app.listen(port, () => {
    logger.info(
      { port, serverUrl: serverUrl.href, auth: authModes },
      `Meta Ads MCP server listening (HTTP transport — auth: ${authModes.join(", ")})`,
    );
  });
}
