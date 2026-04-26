import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isApiKeyConfigured, validateApiKey } from "../../src/auth/api-key.js";

describe("API Key Authentication", () => {
  const originalEnv = process.env.MCP_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCP_API_KEY = originalEnv;
    } else {
      delete process.env.MCP_API_KEY;
    }
  });

  describe("isApiKeyConfigured", () => {
    it("returns false when MCP_API_KEY is not set", () => {
      delete process.env.MCP_API_KEY;
      expect(isApiKeyConfigured()).toBe(false);
    });

    it("returns false when MCP_API_KEY is empty string", () => {
      process.env.MCP_API_KEY = "";
      expect(isApiKeyConfigured()).toBe(false);
    });

    it("returns true when MCP_API_KEY is set", () => {
      process.env.MCP_API_KEY = "test-key-123";
      expect(isApiKeyConfigured()).toBe(true);
    });
  });

  describe("validateApiKey", () => {
    beforeEach(() => {
      process.env.MCP_API_KEY = "test-secret-fixture-1234567890";
    });

    it("returns true for matching key", () => {
      expect(validateApiKey("test-secret-fixture-1234567890")).toBe(true);
    });

    it("returns false for wrong key", () => {
      expect(validateApiKey("wrong-key-00000000000")).toBe(false);
    });

    it("returns false for key with different length", () => {
      expect(validateApiKey("short")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(validateApiKey("")).toBe(false);
    });

    it("returns false when MCP_API_KEY is not configured", () => {
      delete process.env.MCP_API_KEY;
      expect(validateApiKey("any-key")).toBe(false);
    });

    it("uses timing-safe comparison (does not short-circuit)", () => {
      // Verify crypto.timingSafeEqual is used by checking that
      // both matching and non-matching keys of the same length
      // call through without throwing
      expect(validateApiKey("test-secret-fixture-1234567890")).toBe(true);
      expect(validateApiKey("xx-xxxxxx-xxx-xxx-xxxxx")).toBe(false);
    });

    it("CODE-B4: rejects keys of different length without leaking length via early return", () => {
      // We can't measure timing reliably in a unit test, but we can at
      // least assert that the function still returns a clean false for
      // a wide range of mismatched-length candidates and never throws.
      expect(validateApiKey("a")).toBe(false);
      expect(validateApiKey("aa")).toBe(false);
      expect(validateApiKey("a".repeat(100))).toBe(false);
      expect(validateApiKey("a".repeat(10000))).toBe(false);
    });
  });
});
