import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdSetTools } from "./adsets.js";
import { registerAdTools } from "./ads.js";
import { registerCreativeTools } from "./creatives.js";
import { registerInsightsTools } from "./insights.js";
import { registerTargetingTools } from "./targeting.js";
import { registerBudgetTools } from "./budget.js";

/**
 * Register all Meta Ads tools on the MCP server.
 */
export function registerAllTools(server: McpServer): void {
  registerAccountTools(server);      // 3 tools
  registerCampaignTools(server);     // 5 tools
  registerAdSetTools(server);        // 5 tools
  registerAdTools(server);           // 5 tools
  registerCreativeTools(server);     // 4 tools
  registerInsightsTools(server);     // 2 tools
  registerTargetingTools(server);    // 6 tools
  registerBudgetTools(server);       // 1 tool
  // Total: 31 tools
}
