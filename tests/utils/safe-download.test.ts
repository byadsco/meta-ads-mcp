import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { downloadSafePublicImage } from "../../src/utils/safe-download.js";
import { UnsafeUrlError } from "../../src/utils/url-guard.js";

interface FakeResponse {
  statusCode?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Array<Buffer | string>;
}

function fakeResolve(map: Record<string, string[]>) {
  return async (hostname: string) =>
    (map[hostname] ?? []).map((address) => ({ address }));
}

function makeRequest(responses: FakeResponse[]) {
  const calls: Array<{ url: URL; options: Record<string, unknown>; req: { destroy: ReturnType<typeof vi.fn> } }> = [];
  const request = vi.fn((urlInput: URL, options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, cb?: () => void) => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.setTimeout = vi.fn();
    req.destroy = vi.fn((err?: Error) => {
      if (err) queueMicrotask(() => req.emit("error", err));
    });
    calls.push({ url: urlInput, options, req: req as unknown as { destroy: ReturnType<typeof vi.fn> } });
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const next = responses.shift();
        if (!next) {
          req.emit("error", new Error("No fake response queued"));
          return;
        }
        const res = new PassThrough() as IncomingMessage;
        res.statusCode = next.statusCode ?? 200;
        res.headers = next.headers ?? {};
        callback(res);
        for (const chunk of next.chunks ?? []) {
          res.write(chunk);
        }
        res.end();
      });
    });
    return req;
  });

  return { request: request as never, calls };
}

async function runLookup(options: Record<string, unknown>): Promise<{ address: string; family: number }> {
  const lookup = options.lookup as (
    hostname: string,
    options: Record<string, unknown>,
    callback: (err: Error | null, address: string, family: number) => void,
  ) => void;
  return new Promise((resolve, reject) => {
    lookup("cdn.example.com", {}, (err, address, family) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ address, family });
    });
  });
}

describe("downloadSafePublicImage", () => {
  it("downloads a public image under the size limit and pins DNS lookup", async () => {
    const { request, calls } = makeRequest([
      {
        headers: { "content-type": "image/png", "content-length": "7" },
        chunks: [Buffer.from("pngdata")],
      },
    ]);

    const image = await downloadSafePublicImage("https://cdn.example.com/image.png", {
      request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });

    expect(image.buffer.toString()).toBe("pngdata");
    expect(image.contentType).toBe("image/png");
    expect(image.extension).toBe(".png");
    expect(calls).toHaveLength(1);
    await expect(runLookup(calls[0].options)).resolves.toEqual({
      address: "203.0.113.10",
      family: 4,
    });
  });

  it("rejects redirects to non-https URLs", async () => {
    const { request } = makeRequest([
      {
        statusCode: 302,
        headers: { location: "http://cdn.example.com/image.png" },
      },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/start", {
        request,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects redirects to private hosts", async () => {
    const { request } = makeRequest([
      {
        statusCode: 302,
        headers: { location: "https://internal.example.com/image.png" },
      },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/start", {
        request,
        resolve: fakeResolve({
          "cdn.example.com": ["203.0.113.10"],
          "internal.example.com": ["10.0.0.5"],
        }),
      }),
    ).rejects.toThrow(/private IP/);
  });

  it("rejects too many redirects", async () => {
    const { request } = makeRequest([
      { statusCode: 302, headers: { location: "https://cdn.example.com/1" } },
      { statusCode: 302, headers: { location: "https://cdn.example.com/2" } },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/start", {
        request,
        maxRedirects: 1,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("rejects disallowed content-types", async () => {
    const { request } = makeRequest([
      {
        headers: { "content-type": "text/html" },
        chunks: ["<html></html>"],
      },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/image", {
        request,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/content-type/);
  });

  it("accepts common JPEG MIME aliases", async () => {
    const jpg = makeRequest([
      {
        headers: { "content-type": "image/jpg" },
        chunks: [Buffer.from("jpgdata")],
      },
    ]);

    const pjpeg = makeRequest([
      {
        headers: { "content-type": "image/pjpeg" },
        chunks: [Buffer.from("pjpegdata")],
      },
    ]);

    const jpgImage = await downloadSafePublicImage("https://cdn.example.com/image.jpg", {
      request: jpg.request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });
    const pjpegImage = await downloadSafePublicImage("https://cdn.example.com/image2.jpg", {
      request: pjpeg.request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });

    expect(jpgImage.contentType).toBe("image/jpeg");
    expect(jpgImage.extension).toBe(".jpg");
    expect(pjpegImage.contentType).toBe("image/jpeg");
    expect(pjpegImage.extension).toBe(".jpg");
  });

  it("aborts an in-flight image download when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const { request } = makeRequest([
      { headers: { "content-type": "image/jpeg" }, chunks: [Buffer.alloc(4)] },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/image.jpg", {
        request,
        signal: controller.signal,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("destroys the request when a response is rejected instead of draining it", async () => {
    const { request, calls } = makeRequest([
      { headers: { "content-type": "image/jpeg", "content-length": "11" }, chunks: [Buffer.alloc(11)] },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/image.jpg", {
        request, maxBytes: 10, resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/too large/);
    expect(calls[0].req.destroy).toHaveBeenCalled();
  });

  it("aborts while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    const { request, calls } = makeRequest([]);
    const neverResolves = () => new Promise<Array<{ address: string }>>(() => undefined);

    const pending = downloadSafePublicImage("https://cdn.example.com/image.jpg", {
      request, resolve: neverResolves, signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(0);
  });

  it("with a pre-aborted signal, a DNS failure that lands later is never left unhandled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { request } = makeRequest([]);
    let failDns!: (err: Error) => void;
    const lateFailure = () => new Promise<Array<{ address: string }>>((_resolve, reject) => { failDns = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await expect(
        downloadSafePublicImage("https://cdn.example.com/image.jpg", { request, resolve: lateFailure, signal: controller.signal }),
      ).rejects.toThrow(/abort/i);
      // DNS was never started, or if it was, its failure must be swallowed.
      failDns?.(new Error("late DNS failure"));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("enforces an optional host allowlist on the first hop and on every redirect", async () => {
    const resolve = fakeResolve({ "cdn.example.com": ["203.0.113.10"], "scontent.xx.fbcdn.net": ["203.0.113.11"] });
    const direct = makeRequest([{ headers: { "content-type": "image/jpeg" }, chunks: ["x"] }]);
    await expect(
      downloadSafePublicImage("https://cdn.example.com/image.jpg", { request: direct.request, resolve, allowedHostSuffixes: [".fbcdn.net"] }),
    ).rejects.toThrow(/not an allowed/);
    expect(direct.calls).toHaveLength(0);

    const redirected = makeRequest([
      { statusCode: 302, headers: { location: "https://cdn.example.com/other.jpg" } },
      { headers: { "content-type": "image/jpeg" }, chunks: ["x"] },
    ]);
    await expect(
      downloadSafePublicImage("https://scontent.xx.fbcdn.net/image.jpg", { request: redirected.request, resolve, allowedHostSuffixes: [".fbcdn.net"] }),
    ).rejects.toThrow(/not an allowed/);
    expect(redirected.calls).toHaveLength(1);
  });

  it("rejects images whose Content-Length exceeds the limit", async () => {
    const { request } = makeRequest([
      {
        headers: { "content-type": "image/jpeg", "content-length": "11" },
      },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/image.jpg", {
        request,
        maxBytes: 10,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects streams that grow past the limit", async () => {
    const { request } = makeRequest([
      {
        headers: { "content-type": "image/jpeg" },
        chunks: [Buffer.alloc(6), Buffer.alloc(6)],
      },
    ]);

    await expect(
      downloadSafePublicImage("https://cdn.example.com/image.jpg", {
        request,
        maxBytes: 10,
        resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
      }),
    ).rejects.toThrow(/too large/);
  });
});
