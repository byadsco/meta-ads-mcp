import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UnsafeUrlError, type AssertSafeUrlOptions, type ResolvedSafePublicUrl } from "../utils/url-guard.js";
import {
  buildPinnedLookup,
  followSafeRedirects,
  isRedirect,
  parseContentLength,
  parseContentType,
  redirectTarget,
  type HttpsRequestFn,
  type RedirectOrResult,
} from "../utils/safe-http.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Meta's CDN hosts. Ad Library datasets are tenant-controlled input, so
 * without this list a tenant could turn the server into a transcoding proxy
 * for any public URL. Override via VIDEO_ALLOWED_HOST_SUFFIXES (comma-separated).
 */
export const DEFAULT_VIDEO_HOST_SUFFIXES = [".fbcdn.net", ".facebook.com", ".cdninstagram.com"];

// fbcdn occasionally serves mp4 as octet-stream; the bytes are validated by
// ffprobe (or the ftyp signature) after download, so this only screens the obvious.
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
  "application/octet-stream",
]);

export interface SafeVideoDownloadOptions extends AssertSafeUrlOptions {
  /** Directory the file is written into; must already exist. */
  destDir: string;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowedHostSuffixes?: string[];
  request?: HttpsRequestFn;
}

export interface SafeVideoDownload {
  path: string;
  bytes: number;
  contentType: string;
  finalUrl: URL;
}

export function resolveAllowedVideoHostSuffixes(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VIDEO_ALLOWED_HOST_SUFFIXES?.trim();
  if (!raw) return DEFAULT_VIDEO_HOST_SUFFIXES;
  const suffixes = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.startsWith("."));
  return suffixes.length > 0 ? suffixes : DEFAULT_VIDEO_HOST_SUFFIXES;
}

export function assertAllowedVideoHost(url: URL, suffixes: string[]): void {
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
  if (!allowed) {
    throw new UnsafeUrlError(`Host "${host}" is not an allowed video host`);
  }
}

function abortError(): UnsafeUrlError {
  return new UnsafeUrlError("Video download aborted");
}

function requestVideo(
  resolved: ResolvedSafePublicUrl,
  options: {
    request: HttpsRequestFn;
    maxBytes: number;
    timeoutMs: number;
    destDir: string;
    signal?: AbortSignal;
  },
): Promise<RedirectOrResult<SafeVideoDownload>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let filePath: string | undefined;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      const wrapped = err instanceof UnsafeUrlError
        ? err
        : new UnsafeUrlError(`Video download failed: ${err instanceof Error ? err.message : String(err)}`);
      const cleanup = filePath ? fs.rm(filePath, { force: true }) : Promise.resolve();
      void cleanup.finally(() => reject(wrapped));
    };

    if (options.signal?.aborted) {
      fail(abortError());
      return;
    }

    const reqOptions: RequestOptions = {
      method: "GET",
      headers: { Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5" },
      lookup: buildPinnedLookup(resolved),
    };

    const req = options.request(resolved.url, reqOptions, (res: IncomingMessage) => {
      if (isRedirect(res.statusCode)) {
        res.resume();
        try {
          settled = true;
          resolve({ redirectUrl: redirectTarget(res, resolved.url) });
        } catch (err) {
          settled = false;
          fail(err);
        }
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        fail(new UnsafeUrlError(`Failed to download video: HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }

      const contentType = parseContentType(res.headers);
      if (!contentType || !ALLOWED_VIDEO_TYPES.has(contentType)) {
        res.resume();
        fail(new UnsafeUrlError(`Video content-type "${contentType ?? "missing"}" is not allowed`));
        return;
      }

      const contentLength = parseContentLength(res.headers);
      if (contentLength !== null && contentLength > options.maxBytes) {
        res.resume();
        fail(new UnsafeUrlError(`Video is too large: ${contentLength} bytes exceeds ${options.maxBytes}`));
        return;
      }

      filePath = path.join(options.destDir, `${randomUUID()}.mp4`);
      const out = createWriteStream(filePath, { flags: "wx" });
      let total = 0;

      const onAbort = () => {
        res.destroy();
        out.destroy();
        fail(abortError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > options.maxBytes) {
          res.destroy();
          out.destroy();
          fail(new UnsafeUrlError(`Video is too large: exceeded ${options.maxBytes} bytes`));
          return;
        }
        if (!out.write(buffer)) {
          res.pause();
          out.once("drain", () => res.resume());
        }
      });

      res.on("end", () => {
        out.end();
      });

      out.on("finish", () => {
        options.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve({
          path: filePath as string,
          bytes: total,
          contentType,
          finalUrl: resolved.url,
        });
      });

      res.on("error", (err) => {
        options.signal?.removeEventListener("abort", onAbort);
        out.destroy();
        fail(err);
      });
      out.on("error", (err) => {
        options.signal?.removeEventListener("abort", onAbort);
        res.destroy();
        fail(err);
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new UnsafeUrlError(`Video download timed out after ${options.timeoutMs}ms`));
    });

    req.on("error", fail);
    req.end();
  });
}

export async function downloadSafePublicVideo(
  rawUrl: string,
  options: SafeVideoDownloadOptions,
): Promise<SafeVideoDownload> {
  const request = options.request ?? https.request;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const suffixes = options.allowedHostSuffixes ?? resolveAllowedVideoHostSuffixes();

  return followSafeRedirects(
    rawUrl,
    {
      maxRedirects,
      resolve: options.resolve,
      what: "video",
      validateHop: (url) => assertAllowedVideoHost(url, suffixes),
    },
    (resolved) =>
      requestVideo(resolved, {
        request,
        maxBytes,
        timeoutMs,
        destDir: options.destDir,
        signal: options.signal,
      }),
  );
}
