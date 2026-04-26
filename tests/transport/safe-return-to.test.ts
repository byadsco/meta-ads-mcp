import { describe, expect, it } from "vitest";
import { safeReturnTo } from "../../src/transport/auth-routes.js";

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
