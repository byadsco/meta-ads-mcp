import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import { UnsafeUrlError, type AssertSafeUrlOptions, type ResolvedSafePublicUrl } from "./url-guard.js";
import {
  buildPinnedLookup,
  followSafeRedirects,
  isRedirect,
  parseContentLength,
  parseContentType,
  redirectTarget,
  type RedirectOrResult,
} from "./safe-http.js";

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

function normalizeImageContentType(headers: IncomingHttpHeaders): string | null {
  const contentType = parseContentType(headers);
  if (!contentType) return null;
  return JPEG_MIME_ALIASES.has(contentType) ? "image/jpeg" : contentType;
}

function requestImage(
  resolved: ResolvedSafePublicUrl,
  options: Required<Pick<SafeImageDownloadOptions, "maxBytes" | "timeoutMs">> & {
    request: typeof https.request;
  },
): Promise<RedirectOrResult<SafeImageDownload>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reqOptions: RequestOptions = {
      method: "GET",
      headers: { Accept: "image/*" },
      lookup: buildPinnedLookup(resolved),
    };

    const req = options.request(resolved.url, reqOptions, (res: IncomingMessage) => {
      if (isRedirect(res.statusCode)) {
        res.resume();
        try {
          resolve({ redirectUrl: redirectTarget(res, resolved.url) });
        } catch (err) {
          reject(err);
        }
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new UnsafeUrlError(`Failed to download image: HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }

      const contentType = normalizeImageContentType(res.headers);
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

  return followSafeRedirects(
    rawUrl,
    { maxRedirects, resolve: options.resolve, what: "image" },
    (resolved) => requestImage(resolved, { request, maxBytes, timeoutMs }),
  );
}
