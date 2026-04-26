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
  const calls: Array<{ url: URL; options: Record<string, unknown> }> = [];
  const request = vi.fn((urlInput: URL, options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, cb?: () => void) => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    calls.push({ url: urlInput, options });
    req.setTimeout = vi.fn();
    req.destroy = vi.fn((err?: Error) => {
      if (err) queueMicrotask(() => req.emit("error", err));
    });
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
