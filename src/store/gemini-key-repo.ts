import type { Firestore } from "@google-cloud/firestore";
import { decryptToken, encryptToken, type EncryptedPayload } from "../auth/crypto.js";
import { hashToken } from "../auth/token-store.js";
import { getFirestore, isFirestoreEnabled } from "./firestore.js";
import { logger } from "../utils/logger.js";

/**
 * One Gemini API key per tenant, encrypted at rest with the same AES-256-GCM
 * machinery as the Meta and Apify credentials (src/auth/crypto.ts).
 *
 * Layout: users/{fbUserId}/gemini_keys/default
 */

const USERS_COLLECTION = "users";
const GEMINI_KEYS_SUBCOLLECTION = "gemini_keys";
const DOC_ID = "default";

/**
 * Bound into the GCM tag so a (ciphertext, iv, tag) tuple cannot be relocated
 * between users, nor between this collection and meta_tokens / apify_tokens:
 * each credential kind has its own namespace prefix.
 */
function aadFor(fbUserId: string): string {
  return `gemini_key:${fbUserId}:${DOC_ID}`;
}

export interface GeminiKeyDoc {
  encryptedKey: EncryptedPayload;
  /** Truncated SHA-256, for log correlation only. No character of the key is stored in clear. */
  keyHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface GeminiKeyStatus {
  registered: boolean;
  keyFingerprint: string | null;
  updatedAt: number | null;
}

export interface GeminiKeyRepo {
  saveKey(fbUserId: string, key: string): Promise<void>;
  /** Returns null (rather than throwing) when absent so callers can fall through to the env fallback. */
  getDecryptedKey(fbUserId: string): Promise<string | null>;
  getStatus(fbUserId: string): Promise<GeminiKeyStatus>;
  deleteKey(fbUserId: string): Promise<boolean>;
}

const EMPTY_STATUS: GeminiKeyStatus = { registered: false, keyFingerprint: null, updatedAt: null };

function buildDoc(fbUserId: string, key: string, createdAt: number): GeminiKeyDoc {
  return {
    encryptedKey: encryptToken(key, aadFor(fbUserId)),
    keyHash: hashToken(key),
    createdAt,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

function statusFrom(doc: GeminiKeyDoc): GeminiKeyStatus {
  return {
    registered: true,
    keyFingerprint: typeof doc.keyHash === "string" ? doc.keyHash : null,
    updatedAt: doc.updatedAt ?? null,
  };
}

function decryptOrThrow(doc: GeminiKeyDoc, fbUserId: string): string {
  try {
    return decryptToken(doc.encryptedKey, aadFor(fbUserId));
  } catch (error) {
    // A GCM tag mismatch means the ciphertext was written under another user,
    // another credential namespace or another key, or was tampered with.
    // Propagate: degrading an integrity failure to "no key" would silently
    // fall through to a shared fallback credential.
    logger.error({ event: "gemini_key_decrypt_failed" }, "Stored Gemini key failed authenticated decryption");
    throw new Error(
      "Stored Gemini key could not be decrypted (authentication tag mismatch). Re-register it with ads_register_gemini_key.",
      { cause: error },
    );
  }
}

export class InMemoryGeminiKeyRepo implements GeminiKeyRepo {
  private readonly docs = new Map<string, GeminiKeyDoc>();

  async saveKey(fbUserId: string, key: string): Promise<void> {
    const createdAt = this.docs.get(fbUserId)?.createdAt ?? Math.floor(Date.now() / 1000);
    this.docs.set(fbUserId, buildDoc(fbUserId, key, createdAt));
  }

  async getDecryptedKey(fbUserId: string): Promise<string | null> {
    const doc = this.docs.get(fbUserId);
    return doc ? decryptOrThrow(doc, fbUserId) : null;
  }

  async getStatus(fbUserId: string): Promise<GeminiKeyStatus> {
    const doc = this.docs.get(fbUserId);
    return doc ? statusFrom(doc) : { ...EMPTY_STATUS };
  }

  async deleteKey(fbUserId: string): Promise<boolean> {
    return this.docs.delete(fbUserId);
  }
}

export class FirestoreGeminiKeyRepo implements GeminiKeyRepo {
  constructor(private readonly db: Firestore) {}

  private docRef(fbUserId: string) {
    return this.db
      .collection(USERS_COLLECTION)
      .doc(fbUserId)
      .collection(GEMINI_KEYS_SUBCOLLECTION)
      .doc(DOC_ID);
  }

  async saveKey(fbUserId: string, key: string): Promise<void> {
    const ref = this.docRef(fbUserId);
    const snap = await ref.get();
    const existing = snap.exists ? (snap.data() as GeminiKeyDoc) : undefined;
    const createdAt = existing?.createdAt ?? Math.floor(Date.now() / 1000);
    await ref.set(buildDoc(fbUserId, key, createdAt));
  }

  async getDecryptedKey(fbUserId: string): Promise<string | null> {
    const snap = await this.docRef(fbUserId).get();
    if (!snap.exists) return null;
    const doc = snap.data() as GeminiKeyDoc;
    if (!doc?.encryptedKey) return null;
    return decryptOrThrow(doc, fbUserId);
  }

  async getStatus(fbUserId: string): Promise<GeminiKeyStatus> {
    const snap = await this.docRef(fbUserId).get();
    if (!snap.exists) return { ...EMPTY_STATUS };
    return statusFrom(snap.data() as GeminiKeyDoc);
  }

  async deleteKey(fbUserId: string): Promise<boolean> {
    const ref = this.docRef(fbUserId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }
}

let cachedRepo: GeminiKeyRepo | undefined;

export function getGeminiKeyRepo(): GeminiKeyRepo {
  if (cachedRepo) return cachedRepo;
  cachedRepo = isFirestoreEnabled()
    ? new FirestoreGeminiKeyRepo(getFirestore())
    : new InMemoryGeminiKeyRepo();
  return cachedRepo;
}

export function configureGeminiKeyRepoForTests(repo: GeminiKeyRepo | undefined): void {
  cachedRepo = repo;
}
