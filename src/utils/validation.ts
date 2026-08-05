/**
 * Shared validation helpers for tool inputs.
 */

/**
 * Validate that at least one of the given fields is present.
 */
export function requireOneOf(
  obj: Record<string, unknown>,
  fields: string[],
  message?: string,
): void {
  const present = fields.filter(
    (f) => obj[f] !== undefined && obj[f] !== null,
  );
  if (present.length === 0) {
    throw new Error(
      message ?? `At least one of [${fields.join(", ")}] is required.`,
    );
  }
}

/**
 * Build a fields param string for Meta API from an array or use defaults.
 */
export function buildFieldsParam(
  fields: string[] | undefined,
  defaults: string[],
): string {
  return (fields && fields.length > 0 ? fields : defaults).join(",");
}

/**
 * Normalize a url_tags value: Meta stores it without the leading "?", and
 * keeping it would produce "??utm_source=..." in the final click URL.
 */
export function normalizeUrlTags(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
}
