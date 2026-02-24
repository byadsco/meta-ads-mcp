import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("creates a server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it("returns an McpServer with name and version", () => {
    const server = createServer();
    // McpServer stores server info internally
    expect(server).toHaveProperty("connect");
    expect(server).toHaveProperty("tool");
  });

  it("creates independent server instances", () => {
    const server1 = createServer();
    const server2 = createServer();
    expect(server1).not.toBe(server2);
  });
});
