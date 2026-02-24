import { describe, it, expect, afterEach } from "vitest";
import {
  getAccessToken,
  requestContext,
} from "../../src/auth/token-store.js";

describe("getAccessToken", () => {
  afterEach(() => {
    delete process.env.META_ACCESS_TOKEN;
  });

  it("returns token from AsyncLocalStorage context", () => {
    const token = requestContext.run({ accessToken: "ctx-token" }, () => {
      return getAccessToken();
    });
    expect(token).toBe("ctx-token");
  });

  it("falls back to META_ACCESS_TOKEN env var", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    expect(getAccessToken()).toBe("env-token");
  });

  it("prefers context token over env var", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    const token = requestContext.run({ accessToken: "ctx-token" }, () => {
      return getAccessToken();
    });
    expect(token).toBe("ctx-token");
  });

  it("throws when no token is available", () => {
    expect(() => getAccessToken()).toThrow(
      /No Meta access token available/,
    );
  });
});
