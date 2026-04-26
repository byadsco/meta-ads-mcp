import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const STATE_TTL_SECONDS = 10 * 60;
const STATE_AUDIENCE = "meta-oauth-state";

export interface OAuthStatePayload {
  returnTo: string;
  nonce: string;
}

let cachedSecret: Uint8Array | undefined;

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const raw = process.env.SESSION_COOKIE_SECRET;
  if (raw && raw.length >= 32) {
    cachedSecret = new TextEncoder().encode(raw);
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_COOKIE_SECRET is required in production (>=32 chars)",
    );
  }

  cachedSecret = new TextEncoder().encode(
    crypto.randomBytes(32).toString("hex"),
  );
  return cachedSecret;
}

export async function signOAuthState(
  payload: OAuthStatePayload,
): Promise<string> {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    rt: payload.returnTo,
    n: payload.nonce,
    jti: crypto.randomBytes(8).toString("hex"),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + STATE_TTL_SECONDS)
    .sign(secret);
}

export async function verifyOAuthState(
  token: string,
  expectedNonce?: string,
): Promise<OAuthStatePayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      audience: STATE_AUDIENCE,
    });
    if (typeof payload.rt !== "string") return null;
    if (typeof payload.n !== "string") return null;
    if (expectedNonce !== undefined && payload.n !== expectedNonce) return null;
    return { returnTo: payload.rt, nonce: payload.n };
  } catch {
    return null;
  }
}

export function generateOAuthStateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function resetOAuthStateSecretForTests(): void {
  cachedSecret = undefined;
}
