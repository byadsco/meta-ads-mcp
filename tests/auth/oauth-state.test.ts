import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  resetOAuthStateSecretForTests,
  signOAuthState,
  verifyOAuthState,
} from "../../src/auth/oauth-state.js";

const SECRET = "z".repeat(40);
const original = process.env.SESSION_COOKIE_SECRET;

describe("oauth-state", () => {
  beforeEach(() => {
    process.env.SESSION_COOKIE_SECRET = SECRET;
    resetOAuthStateSecretForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_COOKIE_SECRET;
    else process.env.SESSION_COOKIE_SECRET = original;
    resetOAuthStateSecretForTests();
  });

  it("signs and verifies a state token roundtrip", async () => {
    const token = await signOAuthState({ returnTo: "/authorize?x=1", nonce: "nonce-a" });
    expect(token.split(".")).toHaveLength(3);

    const payload = await verifyOAuthState(token, "nonce-a");
    expect(payload).toEqual({ returnTo: "/authorize?x=1", nonce: "nonce-a" });
  });

  it("rejects tampered tokens", async () => {
    const token = await signOAuthState({ returnTo: "/authorize", nonce: "nonce-a" });
    const tampered = token.slice(0, -4) + "AAAA";
    expect(await verifyOAuthState(tampered, "nonce-a")).toBeNull();
  });

  it("rejects tokens signed with a different secret", async () => {
    const token = await signOAuthState({ returnTo: "/authorize", nonce: "nonce-a" });

    process.env.SESSION_COOKIE_SECRET = "q".repeat(40);
    resetOAuthStateSecretForTests();

    expect(await verifyOAuthState(token, "nonce-a")).toBeNull();
  });

  it("rejects tokens with the wrong audience", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ rt: "/authorize", n: "nonce-a", jti: "abc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("some-other-audience")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(secret);

    expect(await verifyOAuthState(token, "nonce-a")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ rt: "/authorize", n: "nonce-a", jti: "abc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("meta-oauth-state")
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 60)
      .sign(secret);

    expect(await verifyOAuthState(token, "nonce-a")).toBeNull();
  });

  it("rejects tokens without a nonce", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ rt: "/authorize", jti: "abc" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("meta-oauth-state")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(secret);

    expect(await verifyOAuthState(token, "nonce-a")).toBeNull();
  });

  it("rejects tokens when the browser nonce does not match", async () => {
    const token = await signOAuthState({ returnTo: "/authorize", nonce: "nonce-a" });
    expect(await verifyOAuthState(token, "nonce-b")).toBeNull();
  });

  it("survives across module instances (stateless)", async () => {
    const tokenA = await signOAuthState({ returnTo: "/authorize", nonce: "nonce-a" });

    resetOAuthStateSecretForTests();

    const payload = await verifyOAuthState(tokenA, "nonce-a");
    expect(payload).toEqual({ returnTo: "/authorize", nonce: "nonce-a" });
  });
});
