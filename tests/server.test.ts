import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";

async function listPublishedTools(): Promise<Tool[]> {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
    await server.close();
  }
}

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

describe("published tool schemas", () => {
  // Gemini's function_declarations reject empty enums and empty/null enum
  // members; one bad member takes down every request for clients with this
  // server attached, so the wire-level schemas must never publish one.
  it("never publish an empty enum or a ''/null enum member over tools/list", async () => {
    const tools = await listPublishedTools();
    expect(tools.length).toBeGreaterThan(50);
    for (const tool of tools) {
      JSON.stringify(tool.inputSchema, (_key, value: unknown) => {
        const candidate = value as { enum?: unknown[] } | null;
        if (candidate && typeof candidate === "object" && Array.isArray(candidate.enum)) {
          expect(candidate.enum.length, `${tool.name} publishes an empty enum`).toBeGreaterThan(0);
          expect(candidate.enum, `${tool.name} publishes "" in an enum`).not.toContain("");
          expect(candidate.enum, `${tool.name} publishes null in an enum`).not.toContain(null);
        }
        return value;
      });
    }
  });

  it("publishes ads_library_scrape.period as an optional four-value enum", async () => {
    const tools = await listPublishedTools();
    const scrape = tools.find((t) => t.name === "ads_library_scrape");
    const schema = scrape?.inputSchema as {
      properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
      required?: string[];
    };
    const period = schema.properties?.period;
    expect(period?.type).toBe("string");
    expect(period?.enum).toEqual(["last24h", "last7d", "last14d", "last30d"]);
    expect(period?.description).toContain("Date range filter");
    expect(schema.required ?? []).not.toContain("period");
  });
});
