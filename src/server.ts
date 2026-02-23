import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Create a new MCP server instance with all Meta Ads tools registered.
 *
 * In stateless HTTP mode, a new server is created per request.
 * In stdio mode, a single server is used for the session.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "meta-ads-mcp",
    version: "1.0.0",
  });

  registerAllTools(server);

  return server;
}
