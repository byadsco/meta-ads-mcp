import { describe, it, expect } from "vitest";
import {
  normalizeAccountId,
  formatBudget,
  truncateResponse,
  validateMetaId,
} from "../../src/utils/format.js";

describe("normalizeAccountId", () => {
  it("adds act_ prefix when missing", () => {
    expect(normalizeAccountId("123456")).toBe("act_123456");
  });

  it("keeps act_ prefix when already present", () => {
    expect(normalizeAccountId("act_123456")).toBe("act_123456");
  });

  it("rejects empty string", () => {
    expect(() => normalizeAccountId("")).toThrow(/Invalid Meta account_id/);
  });

  it("rejects double prefix", () => {
    expect(() => normalizeAccountId("act_act_123")).toThrow(
      /Invalid Meta account_id/,
    );
  });

  it("rejects path traversal attempts (CODE-A5)", () => {
    expect(() => normalizeAccountId("../foo")).toThrow();
    expect(() => normalizeAccountId("123/insights")).toThrow();
    expect(() => normalizeAccountId("act_123?fields=id")).toThrow();
    expect(() => normalizeAccountId("act_ 123")).toThrow();
    expect(() => normalizeAccountId("act_123\n")).toThrow();
  });

  it("rejects non-string", () => {
    // @ts-expect-error testing runtime guard
    expect(() => normalizeAccountId(undefined)).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => normalizeAccountId(123)).toThrow();
  });
});

describe("validateMetaId", () => {
  it("accepts a numeric id", () => {
    expect(validateMetaId("23843234567")).toBe("23843234567");
    expect(validateMetaId("1", "campaign_id")).toBe("1");
  });

  it("rejects act_ prefixed ids (use normalizeAccountId for those)", () => {
    expect(() => validateMetaId("act_123")).toThrow(/Invalid Meta id/);
  });

  it("rejects junk", () => {
    expect(() => validateMetaId("../foo")).toThrow();
    expect(() => validateMetaId("123/x")).toThrow();
    expect(() => validateMetaId("")).toThrow();
    expect(() => validateMetaId("123 456")).toThrow();
  });

  it("propagates the kind label in the error", () => {
    expect(() => validateMetaId("bad", "campaign_id")).toThrow(
      /Invalid Meta campaign_id/,
    );
  });
});

describe("formatBudget", () => {
  it("converts cents to dollars with currency", () => {
    expect(formatBudget(5000, "USD")).toBe("50.00 USD");
  });

  it("uses USD as default currency", () => {
    expect(formatBudget(10050)).toBe("100.50 USD");
  });

  it("handles string input", () => {
    expect(formatBudget("2500", "EUR")).toBe("25.00 EUR");
  });

  it("handles zero", () => {
    expect(formatBudget(0)).toBe("0.00 USD");
  });

  it("handles large amounts", () => {
    expect(formatBudget(10000000, "USD")).toBe("100000.00 USD");
  });

  it("handles negative amounts (refunds)", () => {
    expect(formatBudget(-500, "USD")).toBe("-5.00 USD");
  });
});

describe("truncateResponse", () => {
  it("returns text unchanged when under limit", () => {
    const text = "short text";
    expect(truncateResponse(text)).toBe(text);
  });

  it("returns text unchanged when exactly at limit", () => {
    const text = "a".repeat(50000);
    expect(truncateResponse(text)).toBe(text);
  });

  it("truncates text over default limit", () => {
    const text = "a".repeat(60000);
    const result = truncateResponse(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result.startsWith("a".repeat(50000))).toBe(true);
    expect(result).toContain("... [Response truncated");
  });

  it("respects custom maxLength", () => {
    const text = "abcdefghij";
    const result = truncateResponse(text, 5);
    expect(result).toContain("abcde");
    expect(result).toContain("... [Response truncated");
  });

  it("does not truncate when at custom limit", () => {
    const text = "abcde";
    expect(truncateResponse(text, 5)).toBe("abcde");
  });
});
