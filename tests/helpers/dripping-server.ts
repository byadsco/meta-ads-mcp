import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real local server that answers with `contentType` and then sends one
 * byte every `everyMs`, forever: never silent long enough for an idle
 * timeout. `request` sends a download's request to it whatever its URL.
 */
export async function drippingServer(contentType: string, everyMs: number) {
  let closedByClient!: () => void;
  const clientClosed = new Promise<void>((resolve) => {
    closedByClient = resolve;
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": contentType });
    const drip = setInterval(() => res.write(Buffer.from([1])), everyMs);
    res.on("close", () => {
      clearInterval(drip);
      closedByClient();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const request = ((_url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
    http.request({ host: "127.0.0.1", port, path: "/", method: "GET", headers: options.headers }, callback)) as never;
  return {
    request,
    clientClosed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
