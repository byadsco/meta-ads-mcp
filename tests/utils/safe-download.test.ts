import { EventEmitter } from "node:events";
import https from "node:https";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadSafePublicImage } from "../../src/utils/safe-download.js";
import { UnsafeUrlError } from "../../src/utils/url-guard.js";
import { drippingServer, switchingProtocolsServer } from "../helpers/dripping-server.js";
import { liveHeapBytes, pieceByPieceRequest } from "../helpers/live-heap.js";

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

  it("refuses a PDF unless allowPdf is set, and then downloads it with every other guard", async () => {
    const pdf = { headers: { "content-type": "application/pdf", "content-length": "8" }, chunks: [Buffer.from("%PDF-1.4")] };
    const resolve = fakeResolve({ "cdn.example.com": ["203.0.113.10"] });

    const refused = makeRequest([{ ...pdf }]);
    await expect(downloadSafePublicImage("https://cdn.example.com/guide.pdf", { request: refused.request, resolve }))
      .rejects.toThrow(/not allowed/);

    const allowed = makeRequest([{ ...pdf }]);
    const file = await downloadSafePublicImage("https://cdn.example.com/guide.pdf", { request: allowed.request, resolve, allowPdf: true });
    expect(file.contentType).toBe("application/pdf");
    expect(file.extension).toBe(".pdf");
    await expect(runLookup(allowed.calls[0].options)).resolves.toEqual({ address: "203.0.113.10", family: 4 });
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

  it("keeps the bytes of a body sent a byte at a time, not one object per byte", async () => {
    const pieces = 300_000;
    const { request, res, ready } = pieceByPieceRequest({ "content-type": "image/png" });
    const pending = downloadSafePublicImage("https://cdn.example.com/a.png", {
      request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });
    await ready;

    const before = liveHeapBytes();
    for (let i = 0; i < pieces; i++) res.emit("data", Buffer.from([i & 0xff]));
    const held = liveHeapBytes() - before;
    res.emit("end");
    const image = await pending;

    expect(image.buffer.length).toBe(pieces);
    expect(image.buffer.every((byte, i) => byte === (i & 0xff))).toBe(true);
    // A Buffer kept per piece costs tens of MB of heap here; the blocks hold
    // the same bytes outside the heap.
    expect(held).toBeLessThan(2 * 1024 * 1024);
  });

  it("puts back together a body whose pieces straddle the blocks it is copied into", async () => {
    const body = Buffer.from(Array.from({ length: 300_001 }, (_, i) => (i * 7) & 0xff));
    const cuts = [0, 1, 50_000, 65_536, 65_537, 200_000, 300_001];
    const chunks = cuts.slice(1).map((end, i) => body.subarray(cuts[i], end));
    const { request } = makeRequest([{ headers: { "content-type": "image/png" }, chunks }]);
    const image = await downloadSafePublicImage("https://cdn.example.com/a.png", {
      request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });
    expect(image.buffer.equals(body)).toBe(true);
  });

  it("accepts a body of exactly maxBytes sent in pieces and refuses one byte more", async () => {
    const resolve = fakeResolve({ "cdn.example.com": ["203.0.113.10"] });
    const bytes = (n: number) => Array.from({ length: n }, (_, i) => Buffer.from([i]));

    const exact = makeRequest([{ headers: { "content-type": "image/png" }, chunks: bytes(10) }]);
    const image = await downloadSafePublicImage("https://cdn.example.com/a.png", { request: exact.request, resolve, maxBytes: 10 });
    expect([...image.buffer]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const over = makeRequest([{ headers: { "content-type": "image/png" }, chunks: bytes(11) }]);
    await expect(
      downloadSafePublicImage("https://cdn.example.com/a.png", { request: over.request, resolve, maxBytes: 10 }),
    ).rejects.toThrow(/too large/);
  });

  it("uses its own agent, never the global one an environment proxy can take over", async () => {
    const { request, calls } = makeRequest([{ headers: { "content-type": "image/png" }, chunks: ["x"] }]);
    await downloadSafePublicImage("https://cdn.example.com/a.png", {
      request,
      resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
    });
    const agent = calls[0].options.agent as https.Agent | undefined;
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent).not.toBe(https.globalAgent);
    expect((agent as unknown as { keepAlive: boolean }).keepAlive).toBe(false);
    await expect(runLookup(calls[0].options)).resolves.toEqual({ address: "203.0.113.10", family: 4 });
  });
});

describe("downloadSafePublicImage total deadline", () => {
  const resolve = fakeResolve({ "cdn.example.com": ["203.0.113.10"] });
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  function track<T>(promise: Promise<T>) {
    const state: { done: boolean; value?: T; error?: Error } = { done: false };
    promise.then(
      (value) => Object.assign(state, { done: true, value }),
      (error: Error) => Object.assign(state, { done: true, error }),
    );
    return state;
  }

  it("cuts a server that sends a byte every 200 ms, never idle, at the total limit", async () => {
    const { request, res, ready, calls } = pieceByPieceRequest({ "content-type": "image/png" });
    const download = track(downloadSafePublicImage("https://cdn.example.com/a.png", { request, resolve, deadlineMs: 1_000 }));
    await ready;
    for (let elapsed = 0; elapsed < 3_000 && !download.done; elapsed += 200) {
      res.emit("data", Buffer.from([1]));
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(download.error).toBeInstanceOf(UnsafeUrlError);
    expect(download.error?.message).toMatch(/1000 ms total limit/);
    expect(res.destroy).toHaveBeenCalled();
    expect(calls[0].req.destroy).toHaveBeenCalled();
  });

  it("lets through a download that ends 1 ms before the limit, and stops one still open at it", async () => {
    const early = pieceByPieceRequest({ "content-type": "image/png" });
    const ok = track(downloadSafePublicImage("https://cdn.example.com/a.png", { request: early.request, resolve, deadlineMs: 1_000 }));
    await early.ready;
    early.res.emit("data", Buffer.from("png"));
    await vi.advanceTimersByTimeAsync(999);
    early.res.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.value?.buffer.toString()).toBe("png");
    expect(vi.getTimerCount()).toBe(0);

    const late = pieceByPieceRequest({ "content-type": "image/png" });
    const cut = track(downloadSafePublicImage("https://cdn.example.com/a.png", { request: late.request, resolve, deadlineMs: 1_000 }));
    await late.ready;
    late.res.emit("data", Buffer.from("png"));
    await vi.advanceTimersByTimeAsync(1_000);
    late.res.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(cut.error?.message).toMatch(/1000 ms total limit/);
  });

  it("counts a DNS lookup that never answers", async () => {
    const { request, calls } = makeRequest([]);
    const download = track(
      downloadSafePublicImage("https://cdn.example.com/a.png", { request, resolve: () => new Promise(() => undefined), deadlineMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(download.error?.message).toMatch(/1000 ms total limit/);
    expect(calls).toHaveLength(0);
  });

  it("counts every hop of a redirect chain against one clock", async () => {
    // Each hop's lookup takes 300 ms: three hops fit in the second, the fourth does not.
    const slowResolve = () => new Promise<Array<{ address: string }>>((done) => setTimeout(() => done([{ address: "203.0.113.10" }]), 300));
    const { request, calls } = makeRequest([
      { statusCode: 302, headers: { location: "https://cdn.example.com/2" } },
      { statusCode: 302, headers: { location: "https://cdn.example.com/3" } },
      { statusCode: 302, headers: { location: "https://cdn.example.com/4" } },
      { headers: { "content-type": "image/png" }, chunks: ["png"] },
    ]);
    const download = track(
      downloadSafePublicImage("https://cdn.example.com/1", { request, resolve: slowResolve, maxRedirects: 5, deadlineMs: 1_000 }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(download.error?.message).toMatch(/1000 ms total limit/);
    expect(calls).toHaveLength(3);
  });

  it("still ends a request that closes without a response at the total limit", async () => {
    const closing = vi.fn((_url: URL, _options: Record<string, unknown>) => {
      const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn(), end: vi.fn(() => queueMicrotask(() => req.emit("close"))) });
      return req;
    });
    const download = track(downloadSafePublicImage("https://cdn.example.com/a.png", { request: closing as never, resolve, deadlineMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(download.error?.message).toMatch(/1000 ms total limit/);
  });

  it("says the caller aborted, not the clock, when the caller's signal fires first", async () => {
    const controller = new AbortController();
    const { request, res, ready } = pieceByPieceRequest({ "content-type": "image/png" });
    const download = track(
      downloadSafePublicImage("https://cdn.example.com/a.png", { request, resolve, deadlineMs: 1_000, signal: controller.signal }),
    );
    await ready;
    res.emit("data", Buffer.from([1]));
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(download.error?.message).toBe("Image download aborted");
    expect(res.destroy).toHaveBeenCalled();
  });
});

describe("downloadSafePublicImage against a real dripping server", () => {
  it("closes the connection at the total limit and leaves no error unhandled", async () => {
    const server = await drippingServer("image/png", 20);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        downloadSafePublicImage("https://cdn.example.com/a.png", {
          request: server.request,
          resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
          deadlineMs: 300,
        }).then(() => "finished", (err: Error) => err),
        new Promise((r) => setTimeout(() => r("still running after 2 s"), 2_000)),
      ]);
      expect(outcome).toBeInstanceOf(UnsafeUrlError);
      expect((outcome as Error).message).toMatch(/300 ms total limit/);
      expect(Date.now() - started).toBeLessThan(1_500);
      await server.clientClosed;
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await server.close();
    }
  });
});

describe("downloadSafePublicImage against a server that switches protocols", () => {
  it("refuses a 101 at once instead of waiting forever", async () => {
    const server = await switchingProtocolsServer();
    try {
      const started = Date.now();
      const outcome = await Promise.race([
        downloadSafePublicImage("https://cdn.example.com/a.png", {
          request: server.request,
          resolve: fakeResolve({ "cdn.example.com": ["203.0.113.10"] }),
          deadlineMs: 5_000,
        }).then(() => "finished", (err: Error) => err),
        new Promise((r) => setTimeout(() => r("still running after 2 s"), 2_000)),
      ]);
      expect(outcome).toBeInstanceOf(UnsafeUrlError);
      expect((outcome as Error).message).toMatch(/switched protocols/);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await server.close();
    }
  });
});
