const CONTROL_CHARS = new RegExp("[\\x00-\\x1f\\x7f]+", "g");
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
/** Three or more hyphens are how this server fences untrusted content; inside it they are just text. */
const FENCE_RUN = /-{3,}/g;

/**
 * One bounded line out of untrusted text (advertiser copy, a model's answer):
 * control characters and line separators collapse to spaces, so the text can
 * never break out of the line it is rendered on. The result is data for the
 * agent, never framing.
 */
export function singleLine(value: string | null | undefined, max: number): string {
  if (!value) return "";
  // Sanitize a bounded prefix only: each replace over a multi-megabyte string
  // would allocate another copy of it just for the slice below to discard.
  const cut = value.length > max * 4;
  const head = cut ? value.slice(0, max * 4) : value;
  const flat = head
    .replace(CONTROL_CHARS, " ")
    .replace(LINE_SEPARATORS, " ")
    .replace(FENCE_RUN, "--")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length > max) return flat.slice(0, max) + "…";
  // The prefix may have been all whitespace; say so rather than render an empty field.
  return cut ? flat + "…" : flat;
}
