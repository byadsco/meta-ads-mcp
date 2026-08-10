import { describe, it, expect } from "vitest";
import {
  isSameOriginRequest,
  validateApifyTokenInput,
} from "../../src/transport/auth-routes.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, and carrying the repo's `fixture` marker.
const VALID = "apify_api_testfixture";

describe("validateApifyTokenInput", () => {
  it("accepts a well-formed token and returns it trimmed", () => {
    expect(validateApifyTokenInput(`  ${VALID}  `)).toEqual({
      ok: true,
      token: VALID,
    });
  });

  it("does not require the apify_api_ prefix", () => {
    // Apify could change the format; the upstream /v2/users/me call is the
    // real authority on validity.
    expect(validateApifyTokenInput("some-other-credential")).toEqual({
      ok: true,
      token: "some-other-credential",
    });
  });

  it.each([
    ["empty string", ""],
    ["spaces", "   "],
    ["tab and newline", "\t\n"],
  ])("rejects %s as empty", (_label, input) => {
    expect(validateApifyTokenInput(input)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a token shorter than 10 characters", () => {
    expect(validateApifyTokenInput("a".repeat(9))).toEqual({
      ok: false,
      reason: "too-short",
    });
    expect(validateApifyTokenInput("a".repeat(10)).ok).toBe(true);
  });

  it("rejects a token longer than 200 characters", () => {
    expect(validateApifyTokenInput("a".repeat(201))).toEqual({
      ok: false,
      reason: "too-long",
    });
    expect(validateApifyTokenInput("a".repeat(200)).ok).toBe(true);
  });

  describe("control characters and inner whitespace", () => {
    // The token is interpolated into `Authorization: Bearer ${token}`, so a
    // CR/LF is a header-injection attempt. Reject early and explicitly rather
    // than relying on the HTTP client to throw.
    const CONTROL_CODES: Array<[string, number]> = [
      ["null", 0x00],
      ["tab", 0x09],
      ["line feed", 0x0a],
      ["vertical tab", 0x0b],
      ["form feed", 0x0c],
      ["carriage return", 0x0d],
      ["unit separator", 0x1f],
      ["delete", 0x7f],
    ];

    it.each(CONTROL_CODES)("rejects an embedded %s", (_label, code) => {
      const input = `apify_api_test${String.fromCharCode(code)}fixture`;
      expect(validateApifyTokenInput(input)).toEqual({
        ok: false,
        reason: "illegal-chars",
      });
    });

    it("rejects a CRLF header-injection payload", () => {
      const input = `apify_api_test${String.fromCharCode(0x0d, 0x0a)}X-Evil: 1`;
      expect(validateApifyTokenInput(input)).toEqual({
        ok: false,
        reason: "illegal-chars",
      });
    });

    it("rejects an inner space", () => {
      expect(validateApifyTokenInput("apify_api_test fixture")).toEqual({
        ok: false,
        reason: "illegal-chars",
      });
    });
  });

  it("rejects non-string input", () => {
    for (const input of [undefined, null, 42, {}, []]) {
      expect(validateApifyTokenInput(input as never).ok).toBe(false);
    }
  });
});

describe("isSameOriginRequest", () => {
  const selfOrigin = "https://mcp.byads.co";

  it.each([
    ["same-origin", "same-origin", true],
    ["same-site (sibling subdomain — SameSite would allow this)", "same-site", false],
    ["cross-site", "cross-site", false],
    ["none (no initiating origin)", "none", false],
  ])("Sec-Fetch-Site %s → %s", (_label, secFetchSite, expected) => {
    expect(isSameOriginRequest({ secFetchSite, selfOrigin })).toBe(expected);
  });

  it("Sec-Fetch-Site wins over a spoofable Origin", () => {
    expect(
      isSameOriginRequest({ secFetchSite: "cross-site", origin: selfOrigin, selfOrigin }),
    ).toBe(false);
  });

  it.each([
    ["matching origin", "https://mcp.byads.co", true],
    ["sibling subdomain", "https://evil.byads.co", false],
    ["foreign origin", "https://evil.example", false],
    ["scheme downgrade", "http://mcp.byads.co", false],
    ["sandboxed null origin", "null", false],
    ["unparseable", "not-a-url", false],
  ])("Origin fallback: %s → %s", (_label, origin, expected) => {
    expect(isSameOriginRequest({ origin, selfOrigin })).toBe(expected);
  });

  it("allows a request carrying neither header", () => {
    // Not a browser form post, so no ambient cookie to abuse; the session
    // check still gates it.
    expect(isSameOriginRequest({ selfOrigin })).toBe(true);
  });
});
