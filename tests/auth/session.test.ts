import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  getSession,
  resetSecretCacheForTests,
  setSession,
  type SessionPayload,
} from "../../src/auth/session.js";

const SECRET = "x".repeat(40);
const original = process.env.SESSION_COOKIE_SECRET;

interface CookieCall {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function makeRes() {
  const cookieCalls: CookieCall[] = [];
  const clearCalls: { name: string; options: Record<string, unknown> }[] = [];
  return {
    cookieCalls,
    clearCalls,
    cookie: vi.fn((name: string, value: string, options: Record<string, unknown>) => {
      cookieCalls.push({ name, value, options });
    }),
    clearCookie: vi.fn(
      (name: string, options: Record<string, unknown>) => {
        clearCalls.push({ name, options });
      },
    ),
  };
}

describe("session", () => {
  beforeEach(() => {
    process.env.SESSION_COOKIE_SECRET = SECRET;
    resetSecretCacheForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = original;
    resetSecretCacheForTests();
  });

  it("setSession sets a signed cookie with secure flags", async () => {
    const res = makeRes();
    const payload: SessionPayload = {
      fbUserId: "1234",
      email: "alice@x.com",
      name: "Alice",
    };

    await setSession(res as never, payload);

    expect(res.cookieCalls).toHaveLength(1);
    const call = res.cookieCalls[0];
    expect(call.name).toBe("mcp_session");
    expect(call.options.httpOnly).toBe(true);
    expect(call.options.sameSite).toBe("lax");
    expect(typeof call.value).toBe("string");
    expect(call.value.split(".")).toHaveLength(3);
  });

  it("getSession reads back the same payload", async () => {
    const res = makeRes();
    const payload: SessionPayload = {
      fbUserId: "1234",
      email: "alice@x.com",
      name: "Alice",
    };

    await setSession(res as never, payload);
    const cookie = res.cookieCalls[0].value;

    const fakeReq = { cookies: { mcp_session: cookie } } as never;
    const got = await getSession(fakeReq);
    expect(got).toEqual(payload);
  });

  it("getSession returns null for missing or tampered cookies", async () => {
    expect(await getSession({ cookies: {} } as never)).toBeNull();
    expect(
      await getSession({ cookies: { mcp_session: "garbage.tok.en" } } as never),
    ).toBeNull();
  });

  it("rejects cookies signed with a different secret", async () => {
    const res = makeRes();
    await setSession(res as never, {
      fbUserId: "1234",
      email: null,
      name: null,
    });
    const cookie = res.cookieCalls[0].value;

    process.env.SESSION_COOKIE_SECRET = "y".repeat(40);
    resetSecretCacheForTests();

    const got = await getSession({ cookies: { mcp_session: cookie } } as never);
    expect(got).toBeNull();
  });

  it("clearSession clears the cookie", async () => {
    const res = makeRes();
    await clearSession({ cookies: {} } as never, res as never);
    expect(res.clearCalls).toHaveLength(1);
    expect(res.clearCalls[0].name).toBe("mcp_session");
  });

  it("clearSession invalidates the jti so the cookie no longer authenticates (CODE-M5)", async () => {
    // Set a session
    const res1 = makeRes();
    await setSession(res1 as never, {
      fbUserId: "fb-9",
      email: null,
      name: null,
    });
    const cookie = res1.cookieCalls[0].value;

    // Cookie validates initially
    expect(
      await getSession({ cookies: { mcp_session: cookie } } as never),
    ).toMatchObject({ fbUserId: "fb-9" });

    // Logout
    const res2 = makeRes();
    await clearSession(
      { cookies: { mcp_session: cookie } } as never,
      res2 as never,
    );

    // Same cookie no longer authenticates — even if it was stolen earlier.
    expect(
      await getSession({ cookies: { mcp_session: cookie } } as never),
    ).toBeNull();
  });

  it("CODE-M7: rejects a JWT signed with the same secret but for a different audience (token confusion)", async () => {
    // Forge a JWT with the same secret + structure as a session, but with
    // the audience of an oauth-state. getSession must reject it because
    // it pins audience: "mcp-session".
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(SECRET);
    const forged = await new SignJWT({ fb: "fb-evil", jti: "x".repeat(32) })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("meta-oauth-state") // wrong audience for getSession
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);

    expect(
      await getSession({ cookies: { mcp_session: forged } } as never),
    ).toBeNull();
  });

  it("CODE-M2: uses the __Host- cookie prefix in production", async () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      // Force re-import so the COOKIE_NAME constant picks up production.
      const fresh = await import(
        "../../src/auth/session.ts?prod=" + Date.now()
      );
      const res = makeRes();
      await fresh.setSession(res as never, {
        fbUserId: "fb-prod",
        email: null,
        name: null,
      });
      expect(res.cookieCalls[0].name).toBe("__Host-mcp_session");
      expect(res.cookieCalls[0].options.secure).toBe(true);
      expect(res.cookieCalls[0].options.path).toBe("/");
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("rejects sessions whose jti is unknown (e.g. server restart with in-memory store)", async () => {
    const res = makeRes();
    await setSession(res as never, {
      fbUserId: "fb-1",
      email: null,
      name: null,
    });
    const cookie = res.cookieCalls[0].value;

    // Reset the in-memory jti store
    resetSecretCacheForTests();
    process.env.SESSION_COOKIE_SECRET = SECRET;

    // The cookie is valid signature-wise but jti is gone.
    expect(
      await getSession({ cookies: { mcp_session: cookie } } as never),
    ).toBeNull();
  });
});
