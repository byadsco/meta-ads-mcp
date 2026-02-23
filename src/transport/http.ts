import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authMiddleware } from "../auth/middleware.js";
import { logger } from "../utils/logger.js";

/**
 * Creates and starts an Express HTTP server with StreamableHTTP MCP transport.
 *
 * Runs in stateless mode — each request gets its own transport instance.
 * This allows horizontal scaling and scale-to-zero.
 */
export async function startHttpTransport(
  createServer: () => McpServer,
  port: number,
): Promise<void> {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Health check (no auth)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "meta-ads-mcp", version: "1.0.0" });
  });

  // MCP endpoint — stateless mode
  app.post("/mcp", authMiddleware, async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });

      const server = createServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);

      // Cleanup after response is sent
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

  // Handle GET for SSE streams (required by spec even in stateless mode)
  app.get("/mcp", authMiddleware, async (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "SSE not supported in stateless mode. Use POST.",
      },
      id: null,
    });
  });

  // Handle DELETE for session termination
  app.delete("/mcp", authMiddleware, async (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Session termination not applicable in stateless mode.",
      },
      id: null,
    });
  });

  app.listen(port, () => {
    logger.info({ port }, "Meta Ads MCP server listening (HTTP transport)");
  });
}
