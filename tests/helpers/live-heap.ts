import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Heap still in use after full collections: what the code under test keeps alive. */
export function liveHeapBytes(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/**
 * A request whose response the test feeds by hand, one `data` event per
 * piece, the way a server picks the framing of a chunked body.
 */
export function pieceByPieceRequest(headers: IncomingHttpHeaders) {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers,
    destroy: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  let responded!: () => void;
  const ready = new Promise<void>((resolve) => {
    responded = resolve;
  });
  const calls: Array<{ options: Record<string, unknown> }> = [];
  const request = vi.fn((_url: URL, options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    calls.push({ options });
    return Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(() =>
        queueMicrotask(() => {
          callback(res as unknown as IncomingMessage);
          responded();
        }),
      ),
    });
  });
  return { request: request as never, res, ready, calls };
}
