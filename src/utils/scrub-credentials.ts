/**
 * Credential-shaped query and fragment parameters Meta (or an advertiser's own
 * tracking) can leave in a URL. Matched on the decoded name, so a
 * percent-encoded `access%5Ftoken` is caught as well.
 */
const CREDENTIAL_NAMES = ["access_token", "client_secret", "app_secret", "signed_request", "oauth_token", "api_key", "apikey", "token", "password", "secret"];

/** `access_token`, `access%5Ftoken`, `access.token`, `ACCESS-TOKEN`… */
function namePattern(name: string): string {
  return name
    .split("")
    .map((char) => (char === "_" ? "(?:_|%5[fF]|[.-])" : char))
    .join("");
}

const PARAM_PATTERN = new RegExp(`([?&#;]|^)(${CREDENTIAL_NAMES.map(namePattern).join("|")})=([^&#\\s"']*)`, "gi");

const REDACTED = "[REDACTED]";

/**
 * Removes credential-shaped parameter values from any text, whatever the
 * surrounding string is: a bare URL, a URL inside prose, an error message that
 * quoted one, or a value that does not parse as a URL at all.
 *
 * Only the value is removed. The parameter name stays, so a reader can see
 * that something was stripped and the rest of the string is untouched.
 */
export function scrubCredentials(text: string): string {
  if (!text.includes("=")) return text;
  return text.replace(PARAM_PATTERN, (_match, prefix: string, name: string) => `${prefix}${name}=${REDACTED}`);
}

/** True when the text carries a credential-shaped parameter with a value. */
export function hasCredential(text: string): boolean {
  PARAM_PATTERN.lastIndex = 0;
  return PARAM_PATTERN.test(text);
}
