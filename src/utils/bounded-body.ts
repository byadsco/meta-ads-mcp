export class BodyTooLargeError extends Error {
  constructor(
    readonly detail: string,
    readonly maxBytes: number,
  ) {
    super(`Response body too large (${detail}; limit ${maxBytes} bytes)`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Reads a response body under a byte budget: the declared length is checked
 * first, a streamed body is cancelled as soon as the budget is exceeded, and
 * the fallback path measures UTF-8 bytes rather than UTF-16 units.
 */
export async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(`declared ${declared} bytes`, maxBytes);
  }
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new BodyTooLargeError(`over ${maxBytes} bytes`, maxBytes);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyTooLargeError(`over ${maxBytes} bytes`, maxBytes);
  return text;
}
