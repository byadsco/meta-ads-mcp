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
 * Validate a Meta resource ID before it is interpolated into a Graph API
 * path. Accepts the three formats Meta uses for path segments:
 *   - Plain numeric id: `1234567890` (campaign, adset, ad, creative, page,
 *     business, audience, rule, pixel, study, lead form, video, user…).
 *   - Ad account id: `act_1234567890` (insights/reports `object_id`).
 *   - Post or comment id: `1234567890_9876543210` — Meta's
 *     `effective_object_story_id` and per-page comment ids embed the page
 *     id and the post/comment id separated by an underscore.
 *
 * Reject anything else so a crafted id can't smuggle path traversal,
 * query strings, or whitespace into the URL of a subsequent fetch.
 *
 * Use at the boundary of any tool that takes an id from a caller and
 * forwards it into a Meta API path or a rate-limiter bucket key. Throws
 * with a clear error so the agent can report a meaningful failure rather
 * than letting a malformed id leak into a path segment or bucket name.
 */
const META_ID = /^(act_\d{1,30}|\d{1,30}(_\d{1,30})?)$/;

/** Whether validateMetaId would accept the id. */
export function isMetaId(id: unknown): id is string {
  return typeof id === "string" && META_ID.test(id);
}

export function validateMetaId(id: string, kind = "id"): string {
  if (!isMetaId(id)) {
    throw new Error(
      `Invalid Meta ${kind}: must be numeric, "act_<numeric>" (account), or "<numeric>_<numeric>" (post/comment) — the three formats are mutually exclusive. Got: ${JSON.stringify(id).slice(0, 80)}`,
    );
  }
  return id;
}

/** A Meta id that can only be numeric: a business, creative, Page or media id. */
export function validateNumericId(id: string, kind: string): string {
  if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) {
    throw new Error(`Invalid Meta ${kind}: must be numeric. Got: ${JSON.stringify(id).slice(0, 80)}`);
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
