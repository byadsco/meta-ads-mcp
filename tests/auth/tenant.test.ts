import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestContext } from "../../src/auth/token-store.js";
import { isSingleTenantMode, LOCAL_TENANT_ID, resolveTenantId } from "../../src/auth/tenant.js";

describe("tenant resolution", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.META_APP_ID = process.env.META_APP_ID;
    saved.META_APP_SECRET = process.env.META_APP_SECRET;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("is single-tenant when the Meta app is not configured", () => {
    expect(isSingleTenantMode(["node", "dist/index.js"])).toBe(true);
    expect(resolveTenantId({ argv: ["node", "dist/index.js"], feature: "video" })).toBe(LOCAL_TENANT_ID);
  });

  it("is single-tenant over stdio even when the Meta app is configured", () => {
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = "s".repeat(32);
    expect(isSingleTenantMode(["node", "dist/index.js", "--transport", "stdio"])).toBe(true);
  });

  it("prefers the OAuth identity from the request context", () => {
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = "s".repeat(32);
    const id = requestContext.run({ accessToken: "t", fbUserId: "42" }, () =>
      resolveTenantId({ argv: ["node", "dist/index.js"], feature: "video" }),
    );
    expect(id).toBe("42");
  });

  it("fails closed in multi-tenant mode without an identity, naming the feature", () => {
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = "s".repeat(32);
    expect(() => resolveTenantId({ argv: ["node", "dist/index.js"], feature: "ads_library_*" })).toThrow(
      /ads_library_\* tools need an authenticated user in multi-tenant mode/,
    );
  });
});
