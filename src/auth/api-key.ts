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
 *
 * Constant-time over both *content* and *length* (CODE-B4): the previous
 * implementation early-returned on length mismatch, which leaks the
 * server-side key length to a remote attacker who can measure response
 * timings. We now hash both values to a fixed-width digest and compare
 * those, so the work done is identical whether the candidate matches or
 * not, regardless of input length.
 */
export function validateApiKey(candidate: string): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) return false;

  const candidateDigest = crypto
    .createHash("sha256")
    .update(candidate)
    .digest();
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expected)
    .digest();

  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}
