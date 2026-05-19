import { describe, it, expect } from "vitest";
import { isStdioTransport } from "../../src/utils/transport-mode.js";

describe("isStdioTransport", () => {
  it("detects --transport stdio (space-separated)", () => {
    expect(
      isStdioTransport(["node", "dist/index.js", "--transport", "stdio"]),
    ).toBe(true);
  });

  it("detects --transport=stdio (equals form)", () => {
    expect(
      isStdioTransport(["node", "dist/index.js", "--transport=stdio"]),
    ).toBe(true);
  });

  it("detects -t stdio (short, space-separated)", () => {
    expect(isStdioTransport(["node", "dist/index.js", "-t", "stdio"])).toBe(
      true,
    );
  });

  it("detects -tstdio (short, joined form)", () => {
    expect(isStdioTransport(["node", "dist/index.js", "-tstdio"])).toBe(true);
  });

  it("returns false for -t=stdio because Node parses it as =stdio", () => {
    expect(isStdioTransport(["node", "dist/index.js", "-t=stdio"])).toBe(false);
  });

  it("returns false when no --transport flag is present", () => {
    expect(isStdioTransport(["node", "dist/index.js"])).toBe(false);
  });

  it("returns false for --transport http", () => {
    expect(
      isStdioTransport(["node", "dist/index.js", "--transport", "http"]),
    ).toBe(false);
  });

  it("returns false for --transport=http", () => {
    expect(
      isStdioTransport(["node", "dist/index.js", "--transport=http"]),
    ).toBe(false);
  });

  it("returns false when --transport has no value", () => {
    expect(isStdioTransport(["node", "dist/index.js", "--transport"])).toBe(
      false,
    );
  });

  it("returns false when stdio appears in an unrelated position", () => {
    expect(
      isStdioTransport(["node", "dist/index.js", "--port", "stdio"]),
    ).toBe(false);
  });

  it("ignores other args around the transport flag", () => {
    expect(
      isStdioTransport([
        "node",
        "dist/index.js",
        "--port",
        "3000",
        "--transport",
        "stdio",
        "--verbose",
      ]),
    ).toBe(true);
  });

  it("uses the last transport flag when duplicated", () => {
    expect(
      isStdioTransport([
        "node",
        "dist/index.js",
        "--transport",
        "stdio",
        "--transport",
        "http",
      ]),
    ).toBe(false);

    expect(
      isStdioTransport([
        "node",
        "dist/index.js",
        "--transport",
        "http",
        "--transport",
        "stdio",
      ]),
    ).toBe(true);
  });

  it("ignores transport-looking args after --", () => {
    expect(
      isStdioTransport([
        "node",
        "dist/index.js",
        "--",
        "--transport",
        "stdio",
      ]),
    ).toBe(false);
  });
});
