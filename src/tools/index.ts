import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdSetTools } from "./adsets.js";
import { registerAdTools } from "./ads.js";
import { registerCreativeTools } from "./creatives.js";
import { registerInsightsTools } from "./insights.js";
import { registerInsightsViewTools } from "./insights-views.js";
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
import { registerInstagramTools } from "./instagram.js";
import { registerRateStatusTools } from "./rate-status.js";
import { registerEntityTools } from "./entities.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerHelpTools } from "./help.js";
import { registerMacroTools } from "./macros.js";
import { registerBulkAdTools } from "./bulk-ads.js";
import { registerWhatsAppTools } from "./whatsapp.js";
import { registerWhatsAppTemplateTools } from "./whatsapp-templates.js";
import { registerWhatsAppFlowTools } from "./whatsapp-flows.js";
import { registerWhatsAppConfigTools } from "./whatsapp-config.js";

/**
 * Register all Meta Ads tools on the MCP server.
 *
 * v3.0.0 alignment with Meta's official MCP vocabulary:
 *   - all tools prefixed `ads_*` (no more `meta_ads_*`)
 *   - `ad_set` (with underscore) replaces `adset`
 *   - all tools annotated with ToolAnnotations (readOnlyHint / destructiveHint)
 *   - 5 named insight views + diagnostic + help + agency macro-tools added
 */
export function registerAllTools(server: McpServer): void {
  // ─── Core Ad Management ─────────────────────────────────
  registerAccountTools(server);      // 3 tools
  registerCampaignTools(server);     // 5 tools
  registerAdSetTools(server);        // 6 tools
  registerAdTools(server);           // 6 tools
  registerCreativeTools(server);     // 9 tools
  registerEntityTools(server);       // 3 tools — generic helpers (get_ad_entities, update_entity, activate_entity)
  registerInsightsTools(server);     // 1 tool  — power-tool ads_get_insights
  registerInsightsViewTools(server); // 5 tools — semantic insight views
  registerTargetingTools(server);    // 7 tools
  registerBudgetTools(server);       // 1 tool

  // ─── Extended Features ──────────────────────────────────
  registerLeadTools(server);         // 4 tools — Lead forms & lead download
  registerAudienceTools(server);     // 8 tools — Custom & lookalike audiences (+ share/unshare/get-shared-accounts)
  registerPreviewTools(server);      // 2 tools — Ad preview links
  registerPixelTools(server);        // 5 tools — Pixel & events manager
  registerCommentTools(server);      // 4 tools — Ad comment moderation
  registerRuleTools(server);         // 5 tools — Automated rules
  registerABTestingTools(server);    // 3 tools — A/B split testing
  registerReportTools(server);       // 4 tools — Async scheduled reports (+ run_and_wait)
  registerBillingTools(server);      // 4 tools — Billing, spend limits & invoices
  registerRateStatusTools(server);   // 1 tool — Rate-limit usage + circuit status

  // ─── Diagnostics & Help ─────────────────────────────────
  registerDiagnosticTools(server);   // 3 tools — opportunity_score, dataset_quality, errors
  registerHelpTools(server);         // 1 tool  — help_article search

  // ─── Agency Macros (cross-account) ──────────────────────
  registerMacroTools(server);        // 2 tools — diagnose_underperformance, portfolio_summary
  registerBulkAdTools(server);       // 1 tool  — ads_bulk_create_video_ads (upload → creative → ad)

  // ─── Instagram ──────────────────────────────────────────
  registerInstagramTools(server);    // 2 tools — IG account & media lookup

  // ─── WhatsApp Business ──────────────────────────────────
  registerWhatsAppTools(server);         // 8 tools — WABAs, phone numbers, business profile
  registerWhatsAppTemplateTools(server); // 6 tools — message templates + analytics
  registerWhatsAppFlowTools(server);     // 6 tools — WhatsApp Flows lifecycle
  registerWhatsAppConfigTools(server);   // 7 tools — QR deep links + webhook subscriptions

  // ─── Token Management ────────────────────────────────────
  registerTokenTools(server);        // 4 tools — list / set-active / register / delete

  // Total: 126 tools (79 renamed + 14 new in v3 + 3 audience-sharing + 1 invoices + 27 WhatsApp + 1 url-tags + 1 bulk video ads)
}
