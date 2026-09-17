/**
 * Best-effort removal of credential-shaped values from text this server is
 * about to return. It is defence in depth, not a security boundary: the text
 * it cleans is the advertiser's own content and this server's own error
 * messages, both going back to the tenant they belong to. It is not a
 * sanitizer for hostile input, and exotic encodings (overlong UTF-8, deeply
 * nested percent-encoding, a name broken up by arbitrary characters) are out
 * of its scope by design — chasing those turns into an unwinnable game with
 * no attacker on the other side of it.
 *
 * Credential-shaped parameter names. Compared after normalization, so the
 * spelling in the input does not matter: `access_token`, `access%5Ftoken`,
 * `access%255Ftoken`, `ACCESS-TOKEN` and `%61ccess_token` all reduce to the
 * same key.
 */
const CREDENTIAL_NAMES = [
  "access_token",
  "client_secret",
  "app_secret",
  "client_token",
  "signed_request",
  "oauth_token",
  "refresh_token",
  "id_token",
  "api_key",
  "auth",
  "authorization",
  "token",
  "password",
  "passwd",
  "secret",
  // Deliberately not a bare "key": too broad, and api_key is already covered.
];

/**
 * Reduces a parameter name to what it means: percent-decoded as many times as
 * it takes (bounded), stripped of anything that is not a letter or a digit,
 * lowercased. A legitimate name never needs this, and a name that does is
 * exactly the one trying to hide.
 */
function normalizeName(raw: string): string {
  let value = raw;
  for (let i = 0; i < 4 && value.includes("%"); i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // A stray % is not decodable; the strip below still normalizes it.
      break;
    }
    if (decoded === value) break;
    value = decoded;
  }
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

const CREDENTIAL_KEYS = new Set(CREDENTIAL_NAMES.map(normalizeName));

/** Whether a parameter name means a credential, whatever its spelling. */
export function isCredentialName(raw: string): boolean {
  return CREDENTIAL_KEYS.has(normalizeName(raw));
}

const REDACTED = "[REDACTED]";

/**
 * Whether a credential name appears anywhere in the text, however it is
 * spelled. Used where the whole value can be dropped, so the shape around the
 * name does not matter.
 */
export function mentionsCredential(text: string): boolean {
  const normalized = normalizeName(text);
  for (const key of CREDENTIAL_KEYS) {
    if (normalized.includes(key)) return true;
  }
  return false;
}

/**
 * Every separator a name=value pair can sit behind, plus the start of the
 * text. `/` and `:` are in the set because a fragment is often path-shaped
 * (`#/access_token=…`), which is where a credential hides most easily.
 */
const PAIR = /(^|[?&#;,/:\s])([A-Za-z0-9%_.\-[\]]{1,64})=([^&#;,\s"'<>]*)/g;

/**
 * Removes the value of any credential-shaped parameter from free text: a url
 * inside a sentence, an error message that quoted one, a fragment, or a value
 * that does not parse as a url at all. The name survives, so a reader can see
 * that something was stripped, and every other character is left alone.
 *
 * Names are matched through normalizeName, so an encoded spelling does not
 * get through, and the value ends at the first separator so a legitimate
 * parameter after it is not swallowed.
 */
export function scrubCredentials(text: string): string {
  if (!text.includes("=")) return text;
  return text.replace(PAIR, (match, prefix: string, name: string, value: string) => {
    if (value.length === 0 || !isCredentialName(name)) return match;
    return `${prefix}${name}=${REDACTED}`;
  });
}

/** True when the text carries a credential-shaped parameter with a value. */
export function hasCredential(text: string): boolean {
  return scrubCredentials(text) !== text;
}

/**
 * Same job for a string that is a whole url, using the platform parser so
 * percent-encoded names are decoded the way a server would decode them.
 * Returns undefined when the url does not parse.
 */
export function scrubUrlCredentials(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  let changed = false;

  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
    changed = true;
  }

  const kept: Array<[string, string]> = [];
  let droppedParam = false;
  for (const [name, value] of url.searchParams) {
    if (isCredentialName(name)) droppedParam = true;
    else kept.push([name, value]);
  }
  if (droppedParam) {
    // Rebuilt in one pass: deleting inside the iteration is quadratic in the
    // number of parameters.
    url.search = new URLSearchParams(kept).toString();
    changed = true;
  }

  // A fragment is never needed for a CDN signature and is never sent to the
  // server, so the whole thing goes as soon as it mentions a credential in
  // any shape. That covers the separators and encodings a parameter-by-
  // parameter scrub would have to enumerate.
  if (url.hash.length > 1 && mentionsCredential(url.hash)) {
    url.hash = "";
    changed = true;
  }

  return changed ? url.toString() : raw;
}
