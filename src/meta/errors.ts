import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { MetaApiError } from "./types/common.js";
import { logger } from "../utils/logger.js";

/**
 * Maps Meta Graph API error codes to MCP errors.
 *
 * Meta error reference: https://developers.facebook.com/docs/graph-api/guides/error-handling/
 */
export function mapMetaErrorToMcp(error: MetaApiError): McpError {
  logger.debug({ metaError: error }, "Mapping Meta API error to MCP error");

  const { code, error_subcode, message } = error;

  // Auth errors (invalid/expired token, insufficient permissions)
  if (code === 190 || code === 102 || code === 10) {
    const detail =
      code === 190
        ? "Invalid or expired access token. Please provide a valid token."
        : code === 10
          ? "Insufficient permissions for this operation."
          : "Authentication required.";
    return new McpError(ErrorCode.InvalidRequest, `${detail} (Meta: ${message})`);
  }

  // Rate limiting
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return new McpError(
      ErrorCode.InvalidRequest,
      `Rate limit exceeded. Please wait and try again. (Meta: ${message})`,
    );
  }

  // Invalid parameters
  if (code === 100) {
    // Subcode 33 = too many ids, subcode 2804008 = invalid targeting spec
    return new McpError(
      ErrorCode.InvalidParams,
      `Invalid parameter: ${message}${error_subcode ? ` (subcode: ${error_subcode})` : ""}`,
    );
  }

  // Object not found
  if (code === 803 || code === 100 && error_subcode === 33) {
    return new McpError(ErrorCode.InvalidParams, `Object not found: ${message}`);
  }

  // Duplicate (already exists)
  if (code === 2650) {
    return new McpError(ErrorCode.InvalidRequest, `Duplicate: ${message}`);
  }

  // Unknown / server errors
  if (code === 1 || code === 2) {
    return new McpError(
      ErrorCode.InternalError,
      `Meta API error: ${message}. Please retry.`,
    );
  }

  // Default fallback
  return new McpError(
    ErrorCode.InternalError,
    `Meta API error (code ${code}): ${message}`,
  );
}

/**
 * Check if a response body is a Meta API error
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
