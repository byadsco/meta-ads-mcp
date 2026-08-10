import { describe, expect, it } from "vitest";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  safeReturnTo,
  validateMetaAuthReturn,
} from "../../src/transport/auth-routes.js";

const claudeClient: OAuthClientInformationFull = {
  client_id: "claude-client",
  client_name: "Claude.ai",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
  client_id_issued_at: 0,
};

function makeGetClient(map: Record<string, OAuthClientInformationFull>) {
  return async (id: string) => map[id];
}

describe("safeReturnTo (CODE-M3)", () => {
  it("accepts an internal path", () => {
    expect(safeReturnTo("/foo/bar")).toBe("/foo/bar");
  });

  it("accepts /authorize on its own", () => {
    expect(safeReturnTo("/authorize")).toBe("/authorize");
  });

  it("accepts /authorize with both client_id and redirect_uri", () => {
    const url =
      "/authorize?response_type=code&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=x";
    expect(safeReturnTo(url)).toBe(url);
  });

  it("rejects non-strings", () => {
    expect(safeReturnTo(undefined)).toBe("/authorize");
    expect(safeReturnTo(null)).toBe("/authorize");
    expect(safeReturnTo({ foo: "bar" })).toBe("/authorize");
  });

  it("rejects external URLs", () => {
    expect(safeReturnTo("https://evil.example/")).toBe("/authorize");
    expect(safeReturnTo("http://localhost:3000/")).toBe("/authorize");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeReturnTo("//evil.example/")).toBe("/authorize");
  });

  it("rejects /authorize with one of the OAuth params missing", () => {
    expect(safeReturnTo("/authorize?client_id=abc")).toBe("/authorize");
    expect(safeReturnTo("/authorize?redirect_uri=https://x")).toBe(
      "/authorize",
    );
  });

  it("rejects control characters (header injection defense)", () => {
    expect(safeReturnTo("/foo\nLocation: https://evil.example")).toBe(
      "/authorize",
    );
    expect(safeReturnTo("/foo\rbar")).toBe("/authorize");
    expect(safeReturnTo("/foo\x00bar")).toBe("/authorize");
  });

  it("rejects empty strings", () => {
    expect(safeReturnTo("")).toBe("/authorize");
  });

  it("rejects oversize values", () => {
    expect(safeReturnTo("/" + "a".repeat(3000))).toBe("/authorize");
  });
});

describe("validateMetaAuthReturn", () => {
  it("rejects missing or direct /authorize returns", async () => {
    const getClient = makeGetClient({});

    await expect(validateMetaAuthReturn(undefined, getClient)).resolves.toBeNull();
    await expect(validateMetaAuthReturn("/authorize", getClient)).resolves.toBeNull();
  });

  it("rejects returns with unknown clients", async () => {
    const returnTo =
      "/authorize?response_type=code&client_id=ghost-client&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback";

    await expect(
      validateMetaAuthReturn(returnTo, makeGetClient({})),
    ).resolves.toBeNull();
  });

  it("accepts a valid /authorize return for a registered client", async () => {
    const returnTo =
      "/authorize?response_type=code&client_id=claude-client&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback";

    await expect(
      validateMetaAuthReturn(
        returnTo,
        makeGetClient({ "claude-client": claudeClient }),
      ),
    ).resolves.toBe(returnTo);
  });

  describe("the standalone connections path", () => {
    // /auth/connections must be reachable after login even though it is not an
    // OAuth request. The allowlist is exact-match and query-less on purpose.
    const getClient = makeGetClient({ "claude-client": claudeClient });

    it("accepts the exact connections path", async () => {
      await expect(
        validateMetaAuthReturn("/auth/connections", getClient),
      ).resolves.toBe("/auth/connections");
    });

    it.each([
      ["a query string", "/auth/connections?x=1"],
      ["a fragment-ish suffix", "/auth/connectionsX"],
      ["a deeper path", "/auth/connections/extra"],
      ["a protocol-relative lookalike", "//auth/connections"],
      ["an absolute URL", "https://evil.example/auth/connections"],
      ["traversal back to /authorize", "/auth/connections/../authorize"],
      ["traversal to another auth route", "/auth/connections/../auth/logout"],
      ["a trailing slash", "/auth/connections/"],
      ["an encoded separator", "/auth/connections%3Fx=1"],
    ])("rejects %s", async (_label, input) => {
      await expect(validateMetaAuthReturn(input, getClient)).resolves.toBeNull();
    });
  });
});

describe("safeReturnTo fallback", () => {
  it("defaults to /authorize so existing call sites are unchanged", () => {
    expect(safeReturnTo(undefined)).toBe("/authorize");
    expect(safeReturnTo("https://evil.example/x")).toBe("/authorize");
  });

  it("honors an explicit connections fallback", () => {
    expect(safeReturnTo(undefined, "/auth/connections")).toBe("/auth/connections");
    expect(safeReturnTo("//evil", "/auth/connections")).toBe("/auth/connections");
    expect(safeReturnTo("not-a-path", "/auth/connections")).toBe("/auth/connections");
  });

  it("still prefers a valid input over the fallback", () => {
    expect(safeReturnTo("/auth/connections", "/authorize")).toBe("/auth/connections");
  });

  it("applies the fallback to a param-less /authorize query", () => {
    expect(safeReturnTo("/authorize?client_id=only", "/auth/connections")).toBe(
      "/auth/connections",
    );
  });
});
