import type { Firestore } from "@google-cloud/firestore";
import { decryptToken, encryptToken, type EncryptedPayload } from "../auth/crypto.js";
import { getFirestore, isFirestoreEnabled } from "./firestore.js";
import { logger } from "../utils/logger.js";

/**
 * One Apify API token per tenant, encrypted at rest with the same
 * AES-256-GCM machinery as the Meta tokens (src/auth/crypto.ts).
 *
 * Layout: users/{fbUserId}/apify_tokens/default
 *
 * A subcollection with a fixed `default` doc id mirrors the meta_tokens
 * layout and leaves room for named tokens later without a migration.
 */

const USERS_COLLECTION = "users";
const APIFY_TOKENS_SUBCOLLECTION = "apify_tokens";
const DOC_ID = "default";

/**
 * Bound into the GCM tag so a (ciphertext, iv, tag) tuple cannot be relocated
 * between users — or between the meta_tokens and apify_tokens collections,
 * which is why the namespace prefix differs from meta-token-repo's `mcp_token:`.
 */
function aadFor(fbUserId: string): string {
  return `apify_token:${fbUserId}:${DOC_ID}`;
}

export interface ApifyTokenDoc {
  encryptedToken: EncryptedPayload;
  apifyUserId: string | null;
  apifyUsername: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApifyTokenStatus {
  registered: boolean;
  apifyUserId: string | null;
  apifyUsername: string | null;
  updatedAt: number | null;
}

export interface ApifyTokenRepo {
  saveToken(
    fbUserId: string,
    token: string,
    user: { id: string; username: string } | null,
  ): Promise<void>;
  /** Returns null (rather than throwing) when absent so callers can fall through to the env fallback. */
  getDecryptedToken(fbUserId: string): Promise<string | null>;
  getStatus(fbUserId: string): Promise<ApifyTokenStatus>;
  deleteToken(fbUserId: string): Promise<boolean>;
}

const EMPTY_STATUS: ApifyTokenStatus = {
  registered: false,
  apifyUserId: null,
  apifyUsername: null,
  updatedAt: null,
};

function buildDoc(
  fbUserId: string,
  token: string,
  user: { id: string; username: string } | null,
  createdAt: number,
): ApifyTokenDoc {
  const now = Math.floor(Date.now() / 1000);
  return {
    encryptedToken: encryptToken(token, aadFor(fbUserId)),
    apifyUserId: user?.id ?? null,
    apifyUsername: user?.username ?? null,
    createdAt,
    updatedAt: now,
  };
}

function statusFrom(doc: ApifyTokenDoc): ApifyTokenStatus {
  return {
    registered: true,
    apifyUserId: doc.apifyUserId ?? null,
    apifyUsername: doc.apifyUsername ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
}

export class InMemoryApifyTokenRepo implements ApifyTokenRepo {
  private readonly docs = new Map<string, ApifyTokenDoc>();

  async saveToken(
    fbUserId: string,
    token: string,
    user: { id: string; username: string } | null,
  ): Promise<void> {
    const existing = this.docs.get(fbUserId);
    const createdAt = existing?.createdAt ?? Math.floor(Date.now() / 1000);
    this.docs.set(fbUserId, buildDoc(fbUserId, token, user, createdAt));
  }

  async getDecryptedToken(fbUserId: string): Promise<string | null> {
    const doc = this.docs.get(fbUserId);
    if (!doc) return null;
    return decryptToken(doc.encryptedToken, aadFor(fbUserId));
  }

  async getStatus(fbUserId: string): Promise<ApifyTokenStatus> {
    const doc = this.docs.get(fbUserId);
    return doc ? statusFrom(doc) : { ...EMPTY_STATUS };
  }

  async deleteToken(fbUserId: string): Promise<boolean> {
    return this.docs.delete(fbUserId);
  }
}

export class FirestoreApifyTokenRepo implements ApifyTokenRepo {
  constructor(private readonly db: Firestore) {}

  private docRef(fbUserId: string) {
    return this.db
      .collection(USERS_COLLECTION)
      .doc(fbUserId)
      .collection(APIFY_TOKENS_SUBCOLLECTION)
      .doc(DOC_ID);
  }

  async saveToken(
    fbUserId: string,
    token: string,
    user: { id: string; username: string } | null,
  ): Promise<void> {
    const ref = this.docRef(fbUserId);
    const snap = await ref.get();
    const existing = snap.exists ? (snap.data() as ApifyTokenDoc) : undefined;
    const createdAt = existing?.createdAt ?? Math.floor(Date.now() / 1000);
    await ref.set(buildDoc(fbUserId, token, user, createdAt));
  }

  async getDecryptedToken(fbUserId: string): Promise<string | null> {
    const snap = await this.docRef(fbUserId).get();
    if (!snap.exists) return null;
    const doc = snap.data() as ApifyTokenDoc;
    if (!doc?.encryptedToken) return null;
    try {
      return decryptToken(doc.encryptedToken, aadFor(fbUserId));
    } catch (error) {
      // A GCM tag mismatch means the stored ciphertext was written under a
      // different user, a different key, or was tampered with. Propagate:
      // degrading an integrity failure to "no token" would silently fall
      // through to a shared fallback credential.
      logger.error(
        { event: "apify_token_decrypt_failed" },
        "Stored Apify token failed authenticated decryption",
      );
      throw new Error(
        "Stored Apify token could not be decrypted (authentication tag mismatch). Re-register it with ads_library_register_apify_token.",
        { cause: error },
      );
    }
  }

  async getStatus(fbUserId: string): Promise<ApifyTokenStatus> {
    const snap = await this.docRef(fbUserId).get();
    if (!snap.exists) return { ...EMPTY_STATUS };
    return statusFrom(snap.data() as ApifyTokenDoc);
  }

  async deleteToken(fbUserId: string): Promise<boolean> {
    const ref = this.docRef(fbUserId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await ref.delete();
    return true;
  }
}

let cachedRepo: ApifyTokenRepo | undefined;

export function getApifyTokenRepo(): ApifyTokenRepo {
  if (cachedRepo) return cachedRepo;
  cachedRepo = isFirestoreEnabled()
    ? new FirestoreApifyTokenRepo(getFirestore())
    : new InMemoryApifyTokenRepo();
  return cachedRepo;
}

export function configureApifyTokenRepoForTests(repo: ApifyTokenRepo | undefined): void {
  cachedRepo = repo;
}
