import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { MetaApiError } from "./types/common.js";
import { logger } from "../utils/logger.js";

/**
 * Classification used by the HTTP client to decide whether to retry, trip the
 * circuit breaker, or surface the error immediately.
 */
export type MetaErrorCategory =
  | "auth" // 190, 102, 10 — stop, token issue
  | "invalid_params" // 100, 803 — stop, caller bug
  | "data_per_call_limit" // 100/1487534 — stop, caller must narrow query
  | "duplicate" // 2650 — stop
  | "platform_rate_limit" // 4, 17, 32, 613 — stop, circuit breaker
  | "buc_rate_limit" // 80000-80014 — stop, circuit breaker
  | "global_insights_rate_limit" // 4/1504022 — stop, circuit breaker
  | "abuse_signal" // 613/1996 — CRITICAL, long circuit breaker
  | "temporary_block" // 368, 1487742 — stop, do not retry
  | "transient" // 1, 2 — retry OK
  | "unknown";

export interface MetaErrorClassification {
  category: MetaErrorCategory;
  retryable: boolean;
  throttled: boolean;
  retryAfterMs?: number;
  subcode?: number;
  critical: boolean;
  mcpError: McpError;
}

const BUC_RATE_LIMIT_CODES = new Set([
  80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014,
]);

const BUC_MESSAGES: Record<number, string> = {
  80000: "Ads Insights API",
  80001: "Page-level calls",
  80002: "Instagram",
  80003: "Custom Audiences",
  80004: "Ads Management",
  80005: "Lead Generation",
  80006: "Messenger",
  80008: "WhatsApp Business",
  80009: "Catalog batch",
  80014: "Catalog management",
};

const SUBCODE_ABUSE = 1996;
const SUBCODE_DATA_PER_CALL = 1487534;
const SUBCODE_GLOBAL_INSIGHTS_RATE = 1504022;
const SUBCODE_TEMPORARY_BLOCK = 1487742;

/**
 * Maps a Meta Graph API error to an MCP error AND a structured classification
 * the HTTP client uses to drive retry / circuit-breaker behavior.
 *
 * Meta error reference:
 *   https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 *   https://developers.facebook.com/docs/marketing-api/insights/error-codes
 */
export function classifyMetaError(error: MetaApiError): MetaErrorClassification {
  const { code, error_subcode, message, error_user_title, error_user_msg } = error;

  const metaDetails = [
    error_user_title ? `[${error_user_title}]` : "",
    error_user_msg ?? "",
  ].filter(Boolean).join(" ");
  const detailSuffix = metaDetails ? ` — ${metaDetails}` : "";

  // ─── Abuse signal (subcode 1996) ─────────────────────────────
  // "Inconsistent request volume detected" — this is how Meta flags
  // suspicious traffic and it's a direct precursor to suspensions.
  if (error_subcode === SUBCODE_ABUSE) {
    logger.fatal(
      { event: "META_ABUSE_SIGNAL", code, subcode: error_subcode, message },
      "Meta detected inconsistent request volume — treating as abuse signal",
    );
    return {
      category: "abuse_signal",
      retryable: false,
      throttled: true,
      retryAfterMs: 60 * 60 * 1000, // 60 min minimum cool-down
      subcode: error_subcode,
      critical: true,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `Meta flagged inconsistent request volume (abuse signal). All calls to this account/token halted for 60 min. (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Auth errors ─────────────────────────────────────────────
  if (code === 190 || code === 102 || code === 10) {
    const detail =
      code === 190
        ? "Invalid or expired access token. Please provide a valid token."
        : code === 10
          ? "Insufficient permissions for this operation."
          : "Authentication required.";
    return {
      category: "auth",
      retryable: false,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `${detail} (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Temporary block (user / business suspended) ─────────────
  if (code === 368 || error_subcode === SUBCODE_TEMPORARY_BLOCK) {
    return {
      category: "temporary_block",
      retryable: false,
      throttled: true,
      retryAfterMs: 30 * 60 * 1000,
      subcode: error_subcode,
      critical: true,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `Meta temporarily blocked this user/business. Do not retry until Meta lifts the block. (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Data-per-call limit (100/1487534) ───────────────────────
  // The query itself is too heavy — retrying will fail the same way.
  if (code === 100 && error_subcode === SUBCODE_DATA_PER_CALL) {
    return {
      category: "data_per_call_limit",
      retryable: false,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidParams,
        `Data-per-call limit reached. Reduce date range, number of ad IDs, or metrics — or use an async report. (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Global Insights rate limit (4/1504022) ──────────────────
  if (code === 4 && error_subcode === SUBCODE_GLOBAL_INSIGHTS_RATE) {
    return {
      category: "global_insights_rate_limit",
      retryable: false,
      throttled: true,
      retryAfterMs: 2 * 60 * 1000,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `Global Insights rate limit hit. Backing off for 2 min. (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── BUC rate limits (80000-80014) ───────────────────────────
  if (BUC_RATE_LIMIT_CODES.has(code)) {
    const bucType = BUC_MESSAGES[code] ?? "BUC";
    return {
      category: "buc_rate_limit",
      retryable: false,
      throttled: true,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `${bucType} rate limit reached. Wait before retrying. (Meta code ${code}: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Platform rate limits ────────────────────────────────────
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return {
      category: "platform_rate_limit",
      retryable: false,
      throttled: true,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `Platform rate limit exceeded (Meta code ${code}). Wait before retrying. (Meta: ${message})${detailSuffix}`,
      ),
    };
  }

  // ─── Object not found (100 + subcode 33) ─────────────────────
  if (code === 803 || (code === 100 && error_subcode === 33)) {
    return {
      category: "invalid_params",
      retryable: false,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidParams,
        `Object not found: ${message}${detailSuffix}`,
      ),
    };
  }

  // ─── Generic invalid params ──────────────────────────────────
  if (code === 100) {
    return {
      category: "invalid_params",
      retryable: false,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameter: ${message}${error_subcode ? ` (subcode: ${error_subcode})` : ""}${detailSuffix}`,
      ),
    };
  }

  // ─── Duplicate ───────────────────────────────────────────────
  if (code === 2650) {
    return {
      category: "duplicate",
      retryable: false,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InvalidRequest,
        `Duplicate: ${message}${detailSuffix}`,
      ),
    };
  }

  // ─── Transient server errors (1, 2) ──────────────────────────
  if (code === 1 || code === 2) {
    return {
      category: "transient",
      retryable: true,
      throttled: false,
      subcode: error_subcode,
      critical: false,
      mcpError: new McpError(
        ErrorCode.InternalError,
        `Meta API error: ${message}. Please retry.${detailSuffix}`,
      ),
    };
  }

  // ─── Fallback ────────────────────────────────────────────────
  return {
    category: "unknown",
    retryable: false,
    throttled: false,
    subcode: error_subcode,
    critical: false,
    mcpError: new McpError(
      ErrorCode.InternalError,
      `Meta API error (code ${code}): ${message}${detailSuffix}`,
    ),
  };
}

/**
 * Back-compat thin wrapper used by legacy call-sites.
 */
export function mapMetaErrorToMcp(error: MetaApiError): McpError {
  logger.debug({ metaError: error }, "Mapping Meta API error to MCP error");
  return classifyMetaError(error).mcpError;
}

// Meta answered and turned the call down, or it was never sent: nothing was
// written. Anything else (a lost answer, a timeout, Meta's own "unknown
// error" or "service unavailable") may hide a write that went through.
export function wasRefused(err: unknown): boolean {
  return err instanceof McpError && (err.code === ErrorCode.InvalidParams || err.code === ErrorCode.InvalidRequest);
}

/**
 * Type guard for Meta Graph API error response bodies.
 */
export function isMetaApiError(
  body: unknown,
): body is { error: MetaApiError } {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as Record<string, unknown>).error === "object"
  );
}
