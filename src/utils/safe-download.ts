import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import {
  resolveSafePublicUrl,
  UnsafeUrlError,
  type AssertSafeUrlOptions,
  type ResolvedSafePublicUrl,
} from "./url-guard.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const JPEG_MIME_ALIASES = new Set(["image/jpg", "image/pjpeg"]);

export interface SafeImageDownloadOptions extends AssertSafeUrlOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  request?: typeof https.request;
}

export interface SafeImageDownload {
  buffer: Buffer;
  contentType: string;
  extension: ".jpg" | ".png" | ".gif" | ".webp";
  finalUrl: URL;
}

function extensionFor(contentType: string): SafeImageDownload["extension"] {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/gif") return ".gif";
  if (contentType === "image/webp") return ".webp";
  return ".jpg";
}

function normalizeContentType(headers: IncomingHttpHeaders): string | null {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const contentType = value.split(";")[0].trim().toLowerCase();
  return JPEG_MIME_ALIASES.has(contentType) ? "image/jpeg" : contentType;
}

function parseContentLength(headers: IncomingHttpHeaders): number | null {
  const raw = headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function buildPinnedLookup(resolved: ResolvedSafePublicUrl): LookupFunction {
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

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

type ImageRequestResult =
  | SafeImageDownload
  | { redirectUrl: URL };

function isRedirectResult(result: ImageRequestResult): result is { redirectUrl: URL } {
  return "redirectUrl" in result;
}

function requestImage(
  resolved: ResolvedSafePublicUrl,
  options: Required<Pick<SafeImageDownloadOptions, "maxBytes" | "timeoutMs">> & {
    request: typeof https.request;
  },
): Promise<ImageRequestResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reqOptions: RequestOptions = {
      method: "GET",
      headers: { Accept: "image/*" },
      lookup: buildPinnedLookup(resolved),
    };

    const req = options.request(resolved.url, reqOptions, (res: IncomingMessage) => {
      if (isRedirect(res.statusCode)) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          reject(new UnsafeUrlError(`Redirect from ${resolved.url.hostname} did not include Location`));
          return;
        }
        try {
          resolve({
            redirectUrl: new URL(Array.isArray(location) ? location[0] : location, resolved.url),
          });
        } catch {
          reject(new UnsafeUrlError("Redirect Location is malformed"));
        }
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new UnsafeUrlError(`Failed to download image: HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }

      const contentType = normalizeContentType(res.headers);
      if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) {
        res.resume();
        reject(new UnsafeUrlError(`Image content-type "${contentType ?? "missing"}" is not allowed`));
        return;
      }

      const contentLength = parseContentLength(res.headers);
      if (contentLength !== null && contentLength > options.maxBytes) {
        res.resume();
        reject(new UnsafeUrlError(`Image is too large: ${contentLength} bytes exceeds ${options.maxBytes}`));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;

      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > options.maxBytes) {
          settled = true;
          res.destroy();
          reject(new UnsafeUrlError(`Image is too large: exceeded ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(buffer);
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          buffer: Buffer.concat(chunks),
          contentType,
          extension: extensionFor(contentType),
          finalUrl: resolved.url,
        });
      });

      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof UnsafeUrlError ? err : new UnsafeUrlError(`Image download failed: ${err.message}`));
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new UnsafeUrlError(`Image download timed out after ${options.timeoutMs}ms`));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof UnsafeUrlError ? err : new UnsafeUrlError(`Image download failed: ${err.message}`));
    });

    req.end();
  });
}

export async function downloadSafePublicImage(
  rawUrl: string,
  options: SafeImageDownloadOptions = {},
): Promise<SafeImageDownload> {
  const request = options.request ?? https.request;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let resolved = await resolveSafePublicUrl(rawUrl, { resolve: options.resolve });
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const result = await requestImage(resolved, { request, maxBytes, timeoutMs });
    if (!isRedirectResult(result)) {
      return result;
    }

    if (redirects === maxRedirects) {
      throw new UnsafeUrlError(`Too many redirects while downloading image (max ${maxRedirects})`);
    }
    resolved = await resolveSafePublicUrl(result.redirectUrl.toString(), { resolve: options.resolve });
  }

  throw new UnsafeUrlError(`Too many redirects while downloading image (max ${maxRedirects})`);
}
