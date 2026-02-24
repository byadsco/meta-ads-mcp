/**
 * Shared test helpers and mocks.
 */
import { vi } from "vitest";

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
 * Create a mock McpServer that records tool registrations.
 */
export function createMockMcpServer() {
  const tools: Array<{
    name: string;
    description: string;
    schema: unknown;
    handler: (...args: unknown[]) => Promise<unknown>;
  }> = [];

  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: unknown,
        handler: (...args: unknown[]) => Promise<unknown>,
      ) => {
        tools.push({ name, description, schema, handler });
      },
    ),
    _registeredTools: tools,
  };

  return server;
}
