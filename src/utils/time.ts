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

const OFFSET = /(Z|([+-])(\d{2}):(\d{2}))$/;
const UNIX_SECONDS = /^\d{10}$/;

/**
 * Unix seconds from an exact instant: a time with its offset
 * (2026-11-20T10:00:00-05:00) or Unix seconds, as a number or digits. A day
 * alone is refused, unlike unixSeconds: for a window that moves money, reading
 * it as UTC would shift it by the account's offset without a word. So is a
 * time that does not exist (24:00, February 30), a fraction of a second, and
 * a 13-digit number, which is milliseconds.
 */
export function instantSeconds(value: string | number, name: string): number {
  const refuse = (detail: string): never => {
    throw new Error(`${name} must be a time with its offset (2026-11-20T10:00:00-05:00) or Unix seconds (the same instant is 1795186800)${detail}. Got: ${JSON.stringify(value)?.slice(0, 60)}`);
  };
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 1e12) refuse(": this looks like milliseconds");
    if (!Number.isSafeInteger(value) || value < 1e9 || value >= 1e10) refuse("");
    return value;
  }
  if (typeof value !== "string") return refuse("");
  if (/^\d{13}$/.test(value)) refuse(": this looks like milliseconds");
  if (UNIX_SECONDS.test(value)) return Number(value);
  if (DAY.test(value)) refuse(": a date alone is not enough, since the window would be read as UTC");
  if (!INSTANT.test(value)) refuse("");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) refuse("");
  if (ms % 1000 !== 0) refuse(": use whole seconds");
  const offset = OFFSET.exec(value);
  const offsetMinutes = offset?.[1] === "Z" || !offset ? 0 : (offset[2] === "-" ? -1 : 1) * (Number(offset[3]) * 60 + Number(offset[4]));
  // Date.parse rolls 24:00 and February 30 over into the next day; written
  // back in its own offset, a real time reads the same.
  if (new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 16) !== value.slice(0, 16)) refuse(": that day or time does not exist");
  return ms / 1000;
}

/** Unix seconds from a time Meta returns ("2026-11-04T20:43:13+0000"), or undefined when it is not one. */
export function metaTimeSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}
