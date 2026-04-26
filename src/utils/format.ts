/**
 * Normalize a Meta ad account ID to always include the 'act_' prefix.
 *
 * Validates that the id is purely numeric (optionally with the act_ prefix)
 * before normalizing. Rejects anything containing path-traversal characters,
 * URL components, or whitespace so it can't be smuggled into the path of a
 * subsequent fetch to Meta. CODE-A5 audit finding.
 */
export function normalizeAccountId(id: string): string {
  if (typeof id !== "string" || !/^(act_)?\d{1,30}$/.test(id)) {
    throw new Error(
      `Invalid Meta account_id: must be numeric, optionally prefixed with "act_". Got: ${JSON.stringify(id).slice(0, 80)}`,
    );
  }
  return id.startsWith("act_") ? id : `act_${id}`;
}

/**
 * Validate a Meta resource ID (campaign, adset, ad, creative, page, business…).
 * Meta IDs are always purely numeric strings of variable length.
 *
 * Use at the boundary of any tool that takes an id from a caller and
 * forwards it into a Meta API path or a rate-limiter bucket key. Throws
 * with a clear error so the agent can report a meaningful failure rather
 * than letting a malformed id leak into a path segment or bucket name.
 */
export function validateMetaId(id: string, kind = "id"): string {
  if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) {
    throw new Error(
      `Invalid Meta ${kind}: must be a numeric string. Got: ${JSON.stringify(id).slice(0, 80)}`,
    );
  }
  return id;
}

/**
 * Format a budget value from cents to a human-readable string.
 */
export function formatBudget(
  cents: number | string,
  currency = "USD",
): string {
  const amount = typeof cents === "string" ? parseInt(cents, 10) : cents;
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/**
 * Truncate a string if it exceeds maxLength, appending a note.
 */
export function truncateResponse(
  text: string,
  maxLength = 50000,
): string {
  if (text.length <= maxLength) return text;
  return (
    text.slice(0, maxLength) +
    "\n\n... [Response truncated. Use more specific filters or narrower date ranges to reduce data.]"
  );
}
