import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Standard ToolAnnotations by tool kind, applied across all v3 tools so that
 * MCP clients (Claude, ChatGPT, Perplexity) get consistent confirmation hints.
 *
 * Spread these into the `annotations` field of `server.registerTool(...)`.
 */

export const READ: ToolAnnotations = { readOnlyHint: true };

/** Creates a new entity. Re-running may produce duplicates. */
export const CREATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Updates fields on an existing entity. Same input → same result. */
export const UPDATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Deletes an entity. Cannot be undone; re-deleting is a no-op. */
export const DELETE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
};

/** Status toggle (activate/pause/archive) or comment moderation. */
export const TOGGLE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Uploads media (image/video). New asset every call. */
export const UPLOAD: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Token / session management. */
export const TOKEN: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Prefix every write-tool description so clients that ignore annotations still see the warning. */
export const WRITE_WARNING = "⚠️ Modifies live ads/account data. ";

/** Same, for WhatsApp Business tools. */
export const WHATSAPP_WRITE_WARNING = "⚠️ Modifies live WhatsApp Business data. ";
