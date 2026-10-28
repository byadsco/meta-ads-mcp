const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Unix seconds from a day (2026-10-01, read as UTC) or a time with its offset
 * (2026-10-01T12:00:00Z), the forms Meta's time parameters are given in here.
 * A day alone reads as the start of that day, or as its end with endOfDay, so
 * a window from one day to another includes both. A day that does not exist
 * (2026-02-30) is refused, not rolled into the next month.
 */
export function unixSeconds(value: string, name: string, endOfDay = false): number {
  const day = DAY.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  const realDay = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === value;
  const ms = DAY.test(value)
    ? (realDay ? day + (endOfDay ? 86_399_000 : 0) : NaN)
    : INSTANT.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`${name} must be a date (2026-10-01, read as UTC) or a time with its offset (2026-10-01T12:00:00Z). Got: ${JSON.stringify(value).slice(0, 60)}`);
  }
  return Math.floor(ms / 1000);
}

/** Unix seconds from a time Meta returns ("2026-11-04T20:43:13+0000"), or undefined when it is not one. */
export function metaTimeSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
