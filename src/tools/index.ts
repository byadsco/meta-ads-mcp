import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdSetTools } from "./adsets.js";
import { registerAdTools } from "./ads.js";
import { registerCreativeTools } from "./creatives.js";
import { registerInsightsTools } from "./insights.js";
import { registerTargetingTools } from "./targeting.js";
import { registerBudgetTools } from "./budget.js";
import { registerLeadTools } from "./leads.js";
import { registerAudienceTools } from "./audiences.js";
import { registerPreviewTools } from "./previews.js";
import { registerPixelTools } from "./pixels.js";
import { registerCommentTools } from "./comments.js";
import { registerRuleTools } from "./rules.js";
import { registerABTestingTools } from "./abtesting.js";
import { registerReportTools } from "./reports.js";
import { registerBillingTools } from "./billing.js";
import { registerTokenTools } from "./tokens.js";

/**
 * Register all Meta Ads tools on the MCP server.
 */
export function registerAllTools(server: McpServer): void {
  // ─── Core Ad Management ─────────────────────────────────
  registerAccountTools(server);      // 3 tools
  registerCampaignTools(server);     // 5 tools
  registerAdSetTools(server);        // 5 tools
  registerAdTools(server);           // 5 tools
  registerCreativeTools(server);     // 7 tools (4 original + 3 image/video)
  registerInsightsTools(server);     // 2 tools
  registerTargetingTools(server);    // 6 tools
  registerBudgetTools(server);       // 1 tool

  // ─── Extended Features ──────────────────────────────────
  registerLeadTools(server);         // 4 tools — Lead forms & lead download
  registerAudienceTools(server);     // 5 tools — Custom & lookalike audiences
  registerPreviewTools(server);      // 2 tools — Ad preview links
  registerPixelTools(server);        // 5 tools — Pixel & events manager
  registerCommentTools(server);      // 4 tools — Ad comment moderation
  registerRuleTools(server);         // 5 tools — Automated rules
  registerABTestingTools(server);    // 3 tools — A/B split testing
  registerReportTools(server);       // 3 tools — Async scheduled reports
  registerBillingTools(server);      // 3 tools — Billing & spend limits

  // ─── Token Management ────────────────────────────────────
  registerTokenTools(server);        // 3 tools — Multi-token registry

  // Total: 71 tools
}
