import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";

/**
 * Starts the MCP server with stdio transport.
 * Used for local development and direct MCP client integration.
 */
export async function startStdioTransport(
  server: McpServer,
): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Meta Ads MCP server running (stdio transport)");
}
