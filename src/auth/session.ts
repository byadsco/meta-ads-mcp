import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Request, Response } from "express";
import {
  InMemoryJtiStore,
  type JtiStore,
} from "../store/persistent-jti-store.js";

const COOKIE_NAME = "mcp_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  fbUserId: string;
  email: string | null;
  name: string | null;
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

  cachedSecret = new TextEncoder().encode(crypto.randomBytes(32).toString("hex"));
  return cachedSecret;
}

// Session JWTs are revocable: the cookie carries a jti that must be
// present in the allow-list. clearSession() deletes the jti, so even if
// the cookie was stolen earlier, it stops working as soon as the user
// signs out. Defaults to in-memory; configureSessionJtiStore() swaps it
// for the Firestore impl in production.
let sessionJtiStore: JtiStore = new InMemoryJtiStore();

export function configureSessionJtiStore(store: JtiStore): void {
  sessionJtiStore = store;
}

export async function setSession(
  res: Response,
  payload: SessionPayload,
): Promise<void> {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(16).toString("hex");
  const expiresAt = now + SESSION_TTL_SECONDS;

  const jwt = await new SignJWT({
    fb: payload.fbUserId,
    em: payload.email,
    nm: payload.name,
    jti,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(secret);

  await sessionJtiStore.put(jti, {
    expiresAt,
    meta: { fbUserId: payload.fbUserId },
  });

  res.cookie(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

export async function getSession(
  req: Request,
): Promise<SessionPayload | null> {
  const reqCookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  const cookie = reqCookies?.[COOKIE_NAME];
  if (!cookie) return null;

  try {
    const { payload } = await jwtVerify(cookie, getSecret());
    if (typeof payload.fb !== "string") return null;
    if (typeof payload.jti !== "string") return null;
    if (!(await sessionJtiStore.has(payload.jti))) return null;
    return {
      fbUserId: payload.fb,
      email: typeof payload.em === "string" ? payload.em : null,
      name: typeof payload.nm === "string" ? payload.nm : null,
    };
  } catch {
    return null;
  }
}

export async function clearSession(req: Request, res: Response): Promise<void> {
  // Best-effort: parse the existing cookie to get its jti and remove it
  // from the allow-list. Even if parsing fails (expired/malformed), we
  // still drop the cookie on the client.
  const reqCookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  const cookie = reqCookies?.[COOKIE_NAME];
  if (cookie) {
    try {
      const { payload } = await jwtVerify(cookie, getSecret());
      if (typeof payload.jti === "string") {
        await sessionJtiStore.delete(payload.jti);
      }
    } catch {
      /* ignore */
    }
  }
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function resetSecretCacheForTests(): void {
  cachedSecret = undefined;
  sessionJtiStore = new InMemoryJtiStore();
}
