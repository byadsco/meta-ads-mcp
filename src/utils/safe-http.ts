import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type https from "node:https";
import type { LookupFunction } from "node:net";
import {
  resolveSafePublicUrl,
  UnsafeUrlError,
  type AssertSafeUrlOptions,
  type ResolvedSafePublicUrl,
} from "./url-guard.js";

export type HttpsRequestFn = typeof https.request;

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Pins the socket to the address that passed the SSRF check, so a hostname
 * that re-resolves to a private address between validation and connect
 * (DNS rebinding) cannot redirect the request.
 */
export function buildPinnedLookup(resolved: ResolvedSafePublicUrl): LookupFunction {
  const primary = resolved.addresses[0];
  if (!primary) {
    throw new UnsafeUrlError(`Hostname ${resolved.url.hostname} did not resolve to any address`);
  }

  type LookupOneCallback = (err: Error | null, address: string, family: number) => void;
  type LookupAllCallback = (
    err: Error | null,
    addresses: Array<{ address: string; family: 4 | 6 }>,
  ) => void;

  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === "function" ? options : callback;
    if (!cb) return;
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options && options.all === true;
    if (normalizeHostname(hostname) !== normalizeHostname(resolved.url.hostname)) {
      (cb as LookupOneCallback)(new Error(`Unexpected lookup hostname ${hostname}`), "", 0);
      return;
    }
    if (wantsAll) {
      (cb as LookupAllCallback)(null, resolved.addresses);
      return;
    }
    (cb as LookupOneCallback)(null, primary.address, primary.family);
  }) as LookupFunction;
}

export function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

/** Media type only (no parameters), lowercased; null when the header is absent. */
export function parseContentType(headers: IncomingHttpHeaders): string | null {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return value.split(";")[0].trim().toLowerCase();
}

export function parseContentLength(headers: IncomingHttpHeaders): number | null {
  const raw = headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function redirectTarget(res: IncomingMessage, base: URL): URL {
  const location = res.headers.location;
  if (!location) {
    throw new UnsafeUrlError(`Redirect from ${base.hostname} did not include Location`);
  }
  try {
    return new URL(Array.isArray(location) ? location[0] : location, base);
  } catch {
    throw new UnsafeUrlError("Redirect Location is malformed");
  }
}

export type RedirectOrResult<T> = T | { redirectUrl: URL };

/**
 * Host allowlist by suffix (".fbcdn.net" also matches "fbcdn.net" itself).
 * Applied to the first hop and to every redirect so a permitted host cannot
 * bounce the request elsewhere.
 */
export function assertAllowedHost(url: URL, suffixes: string[], what = "media"): void {
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
  if (!allowed) {
    throw new UnsafeUrlError("Host " + JSON.stringify(host) + " is not an allowed " + what + " host");
  }
}

/**
 * DNS lookups have no cancellation hook, so the wait itself is made abortable.
 * The operation is started lazily: with an already-aborted signal it never
 * runs, and once it has started its eventual settlement is always observed so
 * a late failure cannot surface as an unhandled rejection.
 */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (!signal) return start();
  if (signal.aborted) return Promise.reject(new UnsafeUrlError(`${what} download aborted`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new UnsafeUrlError(`${what} download aborted`));
    signal.addEventListener("abort", onAbort, { once: true });
    start().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export function isRedirectResult<T extends object>(
  result: RedirectOrResult<T>,
): result is { redirectUrl: URL } {
  return "redirectUrl" in result;
}

export interface FollowSafeRedirectsOptions extends AssertSafeUrlOptions {
  maxRedirects: number;
  signal?: AbortSignal;
  /** Extra per-hop policy (e.g. a host allowlist); throw to reject the hop. */
  validateHop?: (url: URL) => void;
  what?: string;
}

/**
 * Runs `perform` against a URL that passed the SSRF check, re-validating every
 * redirect hop through the same guard before following it.
 */
export async function followSafeRedirects<T extends object>(
  rawUrl: string,
  options: FollowSafeRedirectsOptions,
  perform: (resolved: ResolvedSafePublicUrl) => Promise<RedirectOrResult<T>>,
): Promise<T> {
  const what = options.what ?? "resource";
  const resolveHop = (url: string) => abortable(() => resolveSafePublicUrl(url, { resolve: options.resolve }), options.signal, what);
  let resolved = await resolveHop(rawUrl);
  options.validateHop?.(resolved.url);
  for (let redirects = 0; redirects <= options.maxRedirects; redirects++) {
    const result = await perform(resolved);
    if (!isRedirectResult(result)) {
      return result;
    }
    if (redirects === options.maxRedirects) {
      throw new UnsafeUrlError(`Too many redirects while downloading ${what} (max ${options.maxRedirects})`);
    }
    resolved = await resolveHop(result.redirectUrl.toString());
    options.validateHop?.(resolved.url);
  }
  throw new UnsafeUrlError(`Too many redirects while downloading ${what} (max ${options.maxRedirects})`);
}
