import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

let cachedKey: Buffer | undefined;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOKEN_ENCRYPTION_KEY is required in production");
    }
    const generated = crypto.randomBytes(KEY_LENGTH);
    cachedKey = generated;
    return cachedKey;
  }

  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_LENGTH * 2) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters (32 bytes)`,
    );
  }

  cachedKey = Buffer.from(raw, "hex");
  return cachedKey;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Encrypt a token with AES-256-GCM.
 *
 * If `aad` is provided, it is bound into the GCM authentication tag
 * (CODE-B1). At decrypt time the same AAD must be supplied or the auth
 * check fails — this prevents an attacker who has Firestore write access
 * from copying a valid (ciphertext, iv, tag) tuple from one
 * `users/A/meta_tokens/X` doc to another `users/B/meta_tokens/Y` doc and
 * having the server happily decrypt it as B's token. Recommended AAD is
 * `${fbUserId}:${name}` — stable and unique per doc.
 *
 * Records encrypted before this parameter existed will continue to
 * decrypt with `aad` left out (the AAD defaults to empty), so this is
 * fully backward-compatible.
 */
export function encryptToken(
  plaintext: string,
  aad?: string,
): EncryptedPayload {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptToken(payload: EncryptedPayload, aad?: string): string {
  const key = getKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

export function resetKeyCacheForTests(): void {
  cachedKey = undefined;
}
