import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerUrl } from "../../src/transport/http.js";

const KEYS = ["NODE_ENV", "SERVER_URL", "PORT"] as const;
const originalEnv: Record<(typeof KEYS)[number], string | undefined> =
  Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

describe("getServerUrl", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("falls back to localhost outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.PORT = "4321";

    expect(getServerUrl().toString()).toBe("http://localhost:4321/");
  });

  it("requires SERVER_URL in production", () => {
    process.env.NODE_ENV = "production";

    expect(() => getServerUrl()).toThrow(/SERVER_URL environment variable is required in production/);
  });

  it("accepts a public https SERVER_URL in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SERVER_URL = "https://meta-ads-mcp.example.com";

    expect(getServerUrl().toString()).toBe("https://meta-ads-mcp.example.com/");
  });

  it("rejects non-https SERVER_URL in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SERVER_URL = "http://meta-ads-mcp.example.com";

    expect(() => getServerUrl()).toThrow(/must use https/);
  });

  it("rejects localhost and private literal IPs in production", () => {
    process.env.NODE_ENV = "production";
    process.env.SERVER_URL = "https://localhost";
    expect(() => getServerUrl()).toThrow(/real hostname/);

    process.env.SERVER_URL = "https://127.0.0.1";
    expect(() => getServerUrl()).toThrow(/private IP/);

    process.env.SERVER_URL = "https://10.0.0.2";
    expect(() => getServerUrl()).toThrow(/private IP/);
  });
});
