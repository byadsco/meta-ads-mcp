import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { oauthProvider } from "../auth/oauth-provider.js";
import { isApiKeyConfigured, validateApiKey } from "../auth/api-key.js";
import { requestContext } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";

// ── Helpers ──────────────────────────────────────────────────

function getServerUrl(): URL {
  const envUrl = process.env.SERVER_URL;
  if (envUrl) {
    return new URL(envUrl);
  }
  const port = process.env.PORT || "3000";
  return new URL(`http://localhost:${port}`);
}

function renderConsentPage(query: Record<string, string>): string {
  const clientId = query.client_id || "Unknown";
  const hiddenFields = Object.entries(query)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${v.replace(/"/g, "&quot;")}" />`,
    )
    .join("\n        ");

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
    <form method="POST" action="/authorize">
        ${hiddenFields}
        <button type="submit" class="approve">Approve</button>
    </form>
    <form method="GET" action="${query.redirect_uri || "/"}">
        <input type="hidden" name="error" value="access_denied" />
        ${query.state ? `<input type="hidden" name="state" value="${query.state.replace(/"/g, "&quot;")}" />` : ""}
        <button type="submit" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>`;
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
 *  1. X-Meta-Token header (per-request override, e.g. from Manus AI)
 *  2. META_ACCESS_TOKEN environment variable
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

  if (!metaToken) {
    logger.error(
      "No Meta access token: set META_ACCESS_TOKEN env var or pass X-Meta-Token header",
    );
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message:
          "Server configuration error: Meta access token not configured. " +
          "Set META_ACCESS_TOKEN env var or pass X-Meta-Token header.",
      },
      id: null,
    });
    return;
  }

  requestContext.run({ accessToken: metaToken }, () => {
    next();
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

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  const serverUrl = getServerUrl();

  // ── Health check (no auth) ──────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "meta-ads-mcp", version: "1.0.0" });
  });

  // ── Consent page (GET /authorize) ───────────────────────
  // Must be BEFORE mcpAuthRouter so our HTML page is served
  // instead of the SDK's GET handler.
  app.get("/authorize", (req, res) => {
    const query = req.query as Record<string, string>;
    res.type("html").send(renderConsentPage(query));
  });

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
