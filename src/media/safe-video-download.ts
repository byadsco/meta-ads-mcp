import { createWriteStream, promises as fs } from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { UnsafeUrlError, type AssertSafeUrlOptions, type ResolvedSafePublicUrl } from "../utils/url-guard.js";
import {
  assertAllowedHost,
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
  assertAllowedHost(url, suffixes, "video");
}

function abortError(): UnsafeUrlError {
  return new UnsafeUrlError("Video download aborted");
}

/** Filesystem errors carry scratch paths; those must not reach tool output or logs. */
function publicError(err: unknown): UnsafeUrlError {
  if (err instanceof UnsafeUrlError) return err;
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code) && code !== "ECONNRESET" && code !== "ETIMEDOUT" && code !== "ECONNREFUSED") {
    return new UnsafeUrlError(`Video could not be written to scratch storage (${code})`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new UnsafeUrlError(`Video download failed: ${message}`);
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
    let response: IncomingMessage | undefined;
    let out: ReturnType<typeof createWriteStream> | undefined;

    const teardown = () => {
      response?.destroy();
      out?.destroy();
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      const wrapped = publicError(err);
      // Wait for the write stream to release its descriptor before unlinking,
      // otherwise a buffered flush can recreate the partial file after rm.
      const closed = out && !out.closed
        ? new Promise<void>((done) => { out?.once("close", () => done()); })
        : Promise.resolve();
      const cleanup = closed.then(() => (filePath ? fs.rm(filePath, { force: true }) : undefined)).catch(() => undefined);
      void cleanup.then(() => reject(wrapped));
    };

    // Rejected responses are torn down, never drained: a 1 GB video above the
    // cap must not keep transferring outside the job budget.
    const reject_ = (err: UnsafeUrlError) => {
      teardown();
      req.destroy();
      fail(err);
    };

    const onAbort = () => {
      teardown();
      req.destroy();
      fail(abortError());
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
      response = res;
      if (settled) {
        res.destroy();
        return;
      }
      if (isRedirect(res.statusCode)) {
        let target: URL;
        try {
          target = redirectTarget(res, resolved.url);
        } catch (err) {
          reject_(err as UnsafeUrlError);
          return;
        }
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        res.destroy();
        req.destroy();
        resolve({ redirectUrl: target });
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject_(new UnsafeUrlError(`Failed to download video: HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }

      const contentType = parseContentType(res.headers);
      if (!contentType || !ALLOWED_VIDEO_TYPES.has(contentType)) {
        reject_(new UnsafeUrlError(`Video content-type "${contentType ?? "missing"}" is not allowed`));
        return;
      }

      const contentLength = parseContentLength(res.headers);
      if (contentLength !== null && contentLength > options.maxBytes) {
        reject_(new UnsafeUrlError(`Video is too large: ${contentLength} bytes exceeds ${options.maxBytes}`));
        return;
      }

      filePath = path.join(options.destDir, `${randomUUID()}.mp4`);
      const stream = createWriteStream(filePath, { flags: "wx" });
      out = stream;
      let total = 0;

      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > options.maxBytes) {
          reject_(new UnsafeUrlError(`Video is too large: exceeded ${options.maxBytes} bytes`));
          return;
        }
        if (!stream.write(buffer)) {
          res.pause();
          stream.once("drain", () => res.resume());
        }
      });

      res.on("end", () => {
        stream.end();
      });

      stream.on("finish", () => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          path: filePath as string,
          bytes: total,
          contentType,
          finalUrl: resolved.url,
        });
      });

      res.on("error", (err) => {
        stream.destroy();
        fail(err);
      });
      stream.on("error", (err) => {
        res.destroy();
        fail(err);
      });
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });

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
      signal: options.signal,
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
