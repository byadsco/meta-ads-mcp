/**
 * Normalize a Meta ad account ID to always include the 'act_' prefix.
 */
export function normalizeAccountId(id: string): string {
  return id.startsWith("act_") ? id : `act_${id}`;
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
