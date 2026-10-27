/**
 * Shared test helpers and mocks.
 */
import { vi } from "vitest";
import type { Firestore } from "@google-cloud/firestore";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * The parts of Firestore the stores use, kept in a map: a read always sees
 * the last write, as Firestore's own reads do.
 */
export function fakeFirestore(): Firestore {
  const docs = new Map<string, Record<string, unknown>>();
  const snap = (key: string) => ({ exists: docs.has(key), data: () => docs.get(key) });
  const ref = (key: string) => ({
    key,
    get: async () => snap(key),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      docs.set(key, options?.merge ? { ...docs.get(key), ...data } : { ...data });
    },
  });
  type Ref = ReturnType<typeof ref>;
  return {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({
      get: async (r: Ref) => snap(r.key),
      set: (r: Ref, data: Record<string, unknown>) => { docs.set(r.key, { ...data }); },
      update: (r: Ref, data: Record<string, unknown>) => { docs.set(r.key, { ...docs.get(r.key), ...data }); },
      delete: (r: Ref) => { docs.delete(r.key); },
    }),
  } as unknown as Firestore;
}

/**
 * Set a META_ACCESS_TOKEN env var so getAccessToken() doesn't throw.
 */
export function setupTestToken(token = "test-access-token"): void {
  process.env.META_ACCESS_TOKEN = token;
}

/**
 * Remove test env vars.
 */
export function cleanupTestToken(): void {
  delete process.env.META_ACCESS_TOKEN;
}

/**
 * Create a mock fetch Response.
 */
export function mockFetchResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const { status = 200, headers = {} } = options;
  const responseHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Stub fetch for a write followed by the account-currency lookup: every POST
 * gets `write`, GET /act_<id> gets `account`, any other GET gets `entity`.
 */
export function stubWriteAndCurrencyLookup(responses: {
  write: unknown;
  account?: unknown;
  entity?: unknown;
}): void {
  const refused = { error: { code: 100, type: "OAuthException", message: "Unsupported get request." } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return mockFetchResponse(responses.write);
    const body = /\/act_\d+$/.test(new URL(url).pathname) ? responses.account : responses.entity;
    return body === undefined ? mockFetchResponse(refused, { status: 400 }) : mockFetchResponse(body);
  }));
}

/** The fetch calls made so far, as "METHOD /path" without the API version. */
export function fetchCallSummary(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) =>
    `${init?.method ?? "GET"} ${new URL(String(url)).pathname.replace(/^\/v[\d.]+/, "")}`);
}

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  annotations?: ToolAnnotations;
  handler: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Create a mock McpServer that records tool registrations.
 *
 * Supports both the legacy `server.tool(name, description, schema, handler)` API
 * and the modern `server.registerTool(name, config, handler)` API used in v3.
 */
export function createMockMcpServer() {
  const tools: RegisteredTool[] = [];

  const registerTool = vi.fn(
    (
      name: string,
      config: {
        description?: string;
        inputSchema?: unknown;
        annotations?: ToolAnnotations;
      },
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => {
      tools.push({
        name,
        description: config.description ?? "",
        schema: config.inputSchema,
        annotations: config.annotations,
        handler,
      });
    },
  );

  const tool = vi.fn(
    (
      name: string,
      description: string,
      schema: unknown,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => {
      tools.push({ name, description, schema, handler });
    },
  );

  const server = {
    tool,
    registerTool,
    _registeredTools: tools,
  };

  return server;
}
