import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSecurityConfig } from "../../src/transport/security-config.js";

const KEYS = [
  "NODE_ENV",
  "META_APP_ID",
  "META_APP_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "SESSION_COOKIE_SECRET",
  "OAUTH_SECRET",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_ALLOWED_DOMAINS",
  "AUTH_ALLOWED_FB_USER_IDS",
  "OAUTH_APPROVAL_PIN",
] as const;

const originalEnv: Record<(typeof KEYS)[number], string | undefined> =
  Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

const HEX64 = "a".repeat(64);
const SECRET32 = "x".repeat(40);

describe("resolveSecurityConfig", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns single-tenant defaults when META_APP_* are absent", () => {
    process.env.NODE_ENV = "development";
    expect(resolveSecurityConfig()).toEqual({
      metaAppConfigured: false,
      allowlistConfigured: false,
      multiTenantEnabled: false,
    });
  });

  it("requires OAUTH_SECRET in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => resolveSecurityConfig()).toThrow(
      /OAUTH_SECRET environment variable is required in production/,
    );
  });

  it("enables multi-tenant when META_APP_* are present", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    process.env.SESSION_COOKIE_SECRET = SECRET32;
    process.env.AUTH_ALLOWED_EMAILS = "alice@x.com";

    expect(resolveSecurityConfig()).toEqual({
      metaAppConfigured: true,
      allowlistConfigured: true,
      multiTenantEnabled: true,
    });
  });

  it("requires TOKEN_ENCRYPTION_KEY when multi-tenant is enabled", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.SESSION_COOKIE_SECRET = SECRET32;
    process.env.AUTH_ALLOWED_EMAILS = "alice@x.com";

    expect(() => resolveSecurityConfig()).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects malformed TOKEN_ENCRYPTION_KEY", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.TOKEN_ENCRYPTION_KEY = "not-hex";
    process.env.SESSION_COOKIE_SECRET = SECRET32;
    process.env.AUTH_ALLOWED_EMAILS = "alice@x.com";

    expect(() => resolveSecurityConfig()).toThrow(/64 hex characters/);
  });

  it("requires SESSION_COOKIE_SECRET >= 32 chars when multi-tenant", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    process.env.SESSION_COOKIE_SECRET = "short";
    process.env.AUTH_ALLOWED_EMAILS = "alice@x.com";

    expect(() => resolveSecurityConfig()).toThrow(/SESSION_COOKIE_SECRET/);
  });

  it("requires an allowlist when multi-tenant is enabled", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    process.env.SESSION_COOKIE_SECRET = SECRET32;

    expect(() => resolveSecurityConfig()).toThrow(/Allowlist required/);
  });

  it("accepts AUTH_ALLOWED_DOMAINS as the only allowlist source", () => {
    process.env.META_APP_ID = "1234";
    process.env.META_APP_SECRET = "shh";
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    process.env.SESSION_COOKIE_SECRET = SECRET32;
    process.env.AUTH_ALLOWED_DOMAINS = "byads.co";

    expect(resolveSecurityConfig().multiTenantEnabled).toBe(true);
  });

  it("warns but does not throw when OAUTH_APPROVAL_PIN is set", () => {
    process.env.OAUTH_APPROVAL_PIN = "placeholder";
    expect(() => resolveSecurityConfig()).not.toThrow();
  });
});
