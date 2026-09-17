import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadSafePublicVideo } from "../../src/media/safe-video-download.js";
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

function makeRequest(responses: FakeResponse[], behaviour: { holdHeaders?: boolean } = {}) {
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
      if (behaviour.holdHeaders) return;
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

const PUBLIC = fakeResolve({
  "video.xx.fbcdn.net": ["203.0.113.10"],
  "evil.example.com": ["203.0.113.99"],
});

describe("downloadSafePublicVideo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-ads-video-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("streams an mp4 to a file inside destDir and reports its size", async () => {
    const { request, calls } = makeRequest([
      {
        headers: { "content-type": "video/mp4", "content-length": "8" },
        chunks: [Buffer.from("ftypmp42")],
      },
    ]);

    const video = await downloadSafePublicVideo("https://video.xx.fbcdn.net/v/clip.mp4?oe=69617495", {
      request,
      resolve: PUBLIC,
      destDir: dir,
    });

    expect(path.dirname(video.path)).toBe(dir);
    expect(video.bytes).toBe(8);
    expect(video.contentType).toBe("video/mp4");
    expect((await fs.readFile(video.path)).toString()).toBe("ftypmp42");
    expect(calls).toHaveLength(1);
    expect((calls[0].options.headers as Record<string, string>).Accept).toMatch(/video/);
  });

  it("rejects hosts outside the allowlist before sending any request", async () => {
    const { request, calls } = makeRequest([
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.from("x")] },
    ]);

    await expect(
      downloadSafePublicVideo("https://evil.example.com/clip.mp4", {
        request,
        resolve: PUBLIC,
        destDir: dir,
      }),
    ).rejects.toThrow(/not an allowed video host/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a redirect that leaves the allowlist", async () => {
    const { request } = makeRequest([
      { statusCode: 302, headers: { location: "https://evil.example.com/clip.mp4" } },
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.from("x")] },
    ]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/start", {
        request,
        resolve: PUBLIC,
        destDir: dir,
      }),
    ).rejects.toThrow(/not an allowed video host/);
  });

  it("rejects disallowed content-types", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "text/html" }, chunks: ["<html></html>"] },
    ]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip", {
        request,
        resolve: PUBLIC,
        destDir: dir,
      }),
    ).rejects.toThrow(/content-type/);
  });

  it("accepts application/octet-stream (fbcdn sometimes omits the video type)", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "application/octet-stream" }, chunks: [Buffer.from("ftyp")] },
    ]);

    const video = await downloadSafePublicVideo("https://video.xx.fbcdn.net/clip", {
      request,
      resolve: PUBLIC,
      destDir: dir,
    });
    expect(video.contentType).toBe("application/octet-stream");
  });

  it("rejects streams that grow past maxBytes and removes the partial file", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.alloc(6), Buffer.alloc(6)] },
    ]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
        request,
        resolve: PUBLIC,
        destDir: dir,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("rejects a Content-Length above maxBytes without reading the body", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "video/mp4", "content-length": "11" } },
    ]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
        request,
        resolve: PUBLIC,
        destDir: dir,
        maxBytes: 10,
      }),
    ).rejects.toThrow(/too large/);
  });

  it("aborts when the signal fires and removes the partial file", async () => {
    const controller = new AbortController();
    const { request } = makeRequest([
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.alloc(4)] },
    ]);
    controller.abort();

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
        request,
        resolve: PUBLIC,
        destDir: dir,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("lets the caller widen the allowlist", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.from("x")] },
    ]);

    const video = await downloadSafePublicVideo("https://evil.example.com/clip.mp4", {
      request,
      resolve: PUBLIC,
      destDir: dir,
      allowedHostSuffixes: [".example.com"],
    });
    expect(video.bytes).toBe(1);
  });

  it("destroys the connection when a response is rejected instead of draining it", async () => {
    const { request, calls } = makeRequest([
      { headers: { "content-type": "video/mp4", "content-length": "11" }, chunks: [Buffer.alloc(11)] },
    ]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", { request, resolve: PUBLIC, destDir: dir, maxBytes: 10 }),
    ).rejects.toThrow(/too large/);
    const req = calls[0].req;
    expect(req.destroy).toHaveBeenCalled();
  });

  it("aborts a request that has not received headers yet", async () => {
    const controller = new AbortController();
    const { request, calls } = makeRequest([], { holdHeaders: true });

    const pending = downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
      request, resolve: PUBLIC, destDir: dir, signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(calls[0].req.destroy).toHaveBeenCalled();
  });

  it("does not leak scratch paths in error messages", async () => {
    const { request } = makeRequest([
      { headers: { "content-type": "video/mp4" }, chunks: [Buffer.from("x")] },
    ]);

    const err = await downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
      request, resolve: PUBLIC, destDir: path.join(dir, "missing"),
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(UnsafeUrlError);
    expect(err.message).toMatch(/could not be written/);
    expect(err.message).not.toContain(dir);
  });

  it("aborts while DNS resolution is still pending", async () => {
    const controller = new AbortController();
    const { request, calls } = makeRequest([]);
    const neverResolves = () => new Promise<Array<{ address: string }>>(() => undefined);

    const pending = downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
      request, resolve: neverResolves, destDir: dir, signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(0);
  });

  it("wraps errors as UnsafeUrlError", async () => {
    const { request } = makeRequest([{ statusCode: 403, headers: {} }]);

    await expect(
      downloadSafePublicVideo("https://video.xx.fbcdn.net/clip.mp4", {
        request,
        resolve: PUBLIC,
        destDir: dir,
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
