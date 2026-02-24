import crypto from "node:crypto";

/**
 * Check whether API key authentication is configured.
 * Returns true when the MCP_API_KEY environment variable is set.
 */
export function isApiKeyConfigured(): boolean {
  return !!process.env.MCP_API_KEY;
}

/**
 * Validate a candidate API key against the configured MCP_API_KEY.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function validateApiKey(candidate: string): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) return false;

  // Lengths must match for timingSafeEqual
  if (Buffer.byteLength(candidate) !== Buffer.byteLength(expected)) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(candidate),
    Buffer.from(expected),
  );
}
