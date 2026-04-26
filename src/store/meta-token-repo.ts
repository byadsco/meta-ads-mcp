import { getFirestore } from "./firestore.js";
import {
  decryptToken,
  encryptToken,
  type EncryptedPayload,
} from "../auth/crypto.js";
import {
  exchangeForLongLivedToken,
  loadMetaOAuthConfig,
  type MetaProfile,
} from "../auth/meta-oauth.js";
import { logger } from "../utils/logger.js";

const REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

/**
 * AAD string bound into the GCM auth tag for each token (CODE-B1). It's
 * unique per (user, token-name) pair, so a Firestore-write attacker can't
 * rebind a valid ciphertext from one doc to another. Old docs encrypted
 * before AAD support fall back to plain decrypt — see decryptCompat.
 */
function aadFor(fbUserId: string, tokenName: string): string {
  return `mcp_token:${fbUserId}:${tokenName}`;
}

/**
 * Decrypt a token, transparently handling docs encrypted with AAD (new)
 * or without (legacy). On AAD-tag mismatch we retry without AAD; if that
 * also fails the underlying error propagates. Once every doc has been
 * re-encrypted with AAD (e.g. via natural rotation or a one-shot
 * migration script), the legacy fallback can be removed.
 */
function decryptCompat(
  payload: EncryptedPayload,
  fbUserId: string,
  tokenName: string,
): string {
  try {
    return decryptToken(payload, aadFor(fbUserId, tokenName));
  } catch {
    return decryptToken(payload);
  }
}

export type TokenKind = "user" | "system_user";

export interface UserDoc {
  email: string | null;
  name: string | null;
  picture: string | null;
  firstLoginAt: number;
  lastLoginAt: number;
}

export interface MetaTokenDoc {
  encryptedToken: EncryptedPayload;
  kind: TokenKind;
  expiresAt: number | null;
  scopes: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId: string | null;
  businessName: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MetaTokenSummary {
  name: string;
  kind: TokenKind;
  expiresAt: number | null;
  metaUserId: string | null;
  metaUserName: string | null;
  businessId: string | null;
  businessName: string | null;
  isDefault: boolean;
  isExpired: boolean;
}

export interface SaveTokenInput {
  fbUserId: string;
  name: string;
  accessToken: string;
  kind: TokenKind;
  expiresAt: number | null;
  scopes?: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId?: string | null;
  businessName?: string | null;
  setAsDefault?: boolean;
}

export interface MetaTokenRepo {
  upsertUser(fbUserId: string, profile: MetaProfile): Promise<void>;
  getUser(fbUserId: string): Promise<UserDoc | null>;
  saveToken(input: SaveTokenInput): Promise<void>;
  setDefaultToken(fbUserId: string, name: string): Promise<boolean>;
  deleteToken(fbUserId: string, name: string): Promise<boolean>;
  listTokens(fbUserId: string): Promise<MetaTokenSummary[]>;
  getDefaultTokenName(fbUserId: string): Promise<string | null>;
  getDecryptedToken(
    fbUserId: string,
    name?: string,
    serverUrl?: URL,
  ): Promise<string>;
}

function summarize(name: string, doc: MetaTokenDoc, now: number): MetaTokenSummary {
  return {
    name,
    kind: doc.kind,
    expiresAt: doc.expiresAt,
    metaUserId: doc.metaUserId,
    metaUserName: doc.metaUserName,
    businessId: doc.businessId ?? null,
    businessName: doc.businessName ?? null,
    isDefault: doc.isDefault,
    isExpired: doc.expiresAt !== null && doc.expiresAt < now,
  };
}

async function maybeRefresh(
  doc: MetaTokenDoc,
  fbUserId: string,
  tokenName: string,
  serverUrl: URL | undefined,
  persist: (next: { encryptedToken: EncryptedPayload; expiresAt: number; updatedAt: number }) => Promise<void>,
): Promise<string> {
  const plaintext = decryptCompat(doc.encryptedToken, fbUserId, tokenName);

  if (doc.kind === "system_user") {
    return plaintext;
  }

  const now = Math.floor(Date.now() / 1000);
  const isWithinRefreshWindow =
    doc.expiresAt !== null && doc.expiresAt - now < REFRESH_THRESHOLD_SECONDS;

  if (!isWithinRefreshWindow) {
    return plaintext;
  }

  const config = serverUrl ? loadMetaOAuthConfig(serverUrl) : null;
  if (!config) {
    logger.warn(
      { fbUserId, tokenName },
      "Cannot refresh long-lived token: META_APP_ID/SECRET not configured",
    );
    return plaintext;
  }

  try {
    const refreshed = await exchangeForLongLivedToken(config, plaintext);
    await persist({
      encryptedToken: encryptToken(
        refreshed.accessToken,
        aadFor(fbUserId, tokenName),
      ),
      expiresAt: refreshed.expiresAt,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    logger.info(
      {
        fbUserId,
        tokenName,
        expiresAt: refreshed.expiresAt,
        event: "meta_token_refreshed",
      },
      "Refreshed long-lived Meta token",
    );
    return refreshed.accessToken;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const alreadyExpired = doc.expiresAt !== null && doc.expiresAt <= now;
    if (alreadyExpired) {
      logger.warn(
        {
          fbUserId,
          tokenName,
          error: errorMessage,
          event: "meta_token_refresh_failed_expired",
        },
        "Long-lived token refresh failed and token is expired",
      );
      throw new Error(
        `Meta token "${tokenName}" is expired and refresh failed: ${errorMessage}. Please reconnect via /authorize.`,
      );
    }
    logger.warn(
      {
        fbUserId,
        tokenName,
        error: errorMessage,
        event: "meta_token_refresh_failed",
      },
      "Long-lived token refresh failed; using existing token",
    );
    return plaintext;
  }
}

export class FirestoreMetaTokenRepo implements MetaTokenRepo {
  private userDocRef(fbUserId: string) {
    return getFirestore().collection("users").doc(fbUserId);
  }

  private tokenDocRef(fbUserId: string, name: string) {
    return this.userDocRef(fbUserId).collection("meta_tokens").doc(name);
  }

  async upsertUser(fbUserId: string, profile: MetaProfile): Promise<void> {
    const ref = this.userDocRef(fbUserId);
    const now = Math.floor(Date.now() / 1000);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        lastLoginAt: now,
      });
    } else {
      const doc: UserDoc = {
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        firstLoginAt: now,
        lastLoginAt: now,
      };
      await ref.set(doc);
    }
  }

  async getUser(fbUserId: string): Promise<UserDoc | null> {
    const snap = await this.userDocRef(fbUserId).get();
    if (!snap.exists) return null;
    return snap.data() as UserDoc;
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const encryptedToken = encryptToken(
      input.accessToken,
      aadFor(input.fbUserId, input.name),
    );

    const doc: MetaTokenDoc = {
      encryptedToken,
      kind: input.kind,
      expiresAt: input.expiresAt,
      scopes: input.scopes ?? [],
      metaUserId: input.metaUserId,
      metaUserName: input.metaUserName,
      businessId: input.businessId ?? null,
      businessName: input.businessName ?? null,
      isDefault: input.setAsDefault ?? false,
      createdAt: now,
      updatedAt: now,
    };

    if (input.setAsDefault) {
      await this.clearDefaults(input.fbUserId);
    } else {
      const existingDefault = await this.getDefaultTokenName(input.fbUserId);
      if (!existingDefault) {
        doc.isDefault = true;
      }
    }

    await this.tokenDocRef(input.fbUserId, input.name).set(doc, { merge: false });
  }

  private async clearDefaults(fbUserId: string): Promise<void> {
    const tokens = await this.userDocRef(fbUserId).collection("meta_tokens").get();
    const batch = getFirestore().batch();
    for (const snap of tokens.docs) {
      batch.update(snap.ref, { isDefault: false });
    }
    if (!tokens.empty) await batch.commit();
  }

  async setDefaultToken(fbUserId: string, name: string): Promise<boolean> {
    const ref = this.tokenDocRef(fbUserId, name);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await this.clearDefaults(fbUserId);
    await ref.update({ isDefault: true, updatedAt: Math.floor(Date.now() / 1000) });
    return true;
  }

  async deleteToken(fbUserId: string, name: string): Promise<boolean> {
    const ref = this.tokenDocRef(fbUserId, name);
    const snap = await ref.get();
    if (!snap.exists) return false;
    const wasDefault = (snap.data() as MetaTokenDoc).isDefault;
    await ref.delete();
    if (wasDefault) {
      const remaining = await this.userDocRef(fbUserId)
        .collection("meta_tokens")
        .limit(1)
        .get();
      if (!remaining.empty) {
        await remaining.docs[0].ref.update({ isDefault: true });
      }
    }
    return true;
  }

  async listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
    const snap = await this.userDocRef(fbUserId).collection("meta_tokens").get();
    const now = Math.floor(Date.now() / 1000);
    return snap.docs.map((d) => summarize(d.id, d.data() as MetaTokenDoc, now));
  }

  async getDefaultTokenName(fbUserId: string): Promise<string | null> {
    const snap = await this.userDocRef(fbUserId)
      .collection("meta_tokens")
      .where("isDefault", "==", true)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].id;
  }

  async getDecryptedToken(
    fbUserId: string,
    name?: string,
    serverUrl?: URL,
  ): Promise<string> {
    const tokenName = name ?? (await this.getDefaultTokenName(fbUserId));
    if (!tokenName) {
      throw new Error(`No Meta token registered for user ${fbUserId}`);
    }

    const ref = this.tokenDocRef(fbUserId, tokenName);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`Meta token "${tokenName}" not found for user ${fbUserId}`);
    }

    const data = snap.data() as MetaTokenDoc;
    return maybeRefresh(data, fbUserId, tokenName, serverUrl, async (next) => {
      await ref.update(next);
    });
  }
}

export class InMemoryMetaTokenRepo implements MetaTokenRepo {
  private users = new Map<string, UserDoc>();
  private tokens = new Map<string, Map<string, MetaTokenDoc>>();

  private getUserTokens(fbUserId: string): Map<string, MetaTokenDoc> {
    let bucket = this.tokens.get(fbUserId);
    if (!bucket) {
      bucket = new Map();
      this.tokens.set(fbUserId, bucket);
    }
    return bucket;
  }

  async upsertUser(fbUserId: string, profile: MetaProfile): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.users.get(fbUserId);
    if (existing) {
      this.users.set(fbUserId, {
        ...existing,
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        lastLoginAt: now,
      });
    } else {
      this.users.set(fbUserId, {
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        firstLoginAt: now,
        lastLoginAt: now,
      });
    }
  }

  async getUser(fbUserId: string): Promise<UserDoc | null> {
    return this.users.get(fbUserId) ?? null;
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const bucket = this.getUserTokens(input.fbUserId);

    let isDefault = input.setAsDefault ?? false;
    if (input.setAsDefault) {
      for (const [k, v] of bucket) {
        bucket.set(k, { ...v, isDefault: false });
      }
    } else {
      const existingDefault = await this.getDefaultTokenName(input.fbUserId);
      if (!existingDefault) {
        isDefault = true;
      }
    }

    bucket.set(input.name, {
      encryptedToken: encryptToken(
        input.accessToken,
        aadFor(input.fbUserId, input.name),
      ),
      kind: input.kind,
      expiresAt: input.expiresAt,
      scopes: input.scopes ?? [],
      metaUserId: input.metaUserId,
      metaUserName: input.metaUserName,
      businessId: input.businessId ?? null,
      businessName: input.businessName ?? null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    });
  }

  async setDefaultToken(fbUserId: string, name: string): Promise<boolean> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket || !bucket.has(name)) return false;
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of bucket) {
      bucket.set(k, { ...v, isDefault: k === name, updatedAt: k === name ? now : v.updatedAt });
    }
    return true;
  }

  async deleteToken(fbUserId: string, name: string): Promise<boolean> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return false;
    const existing = bucket.get(name);
    if (!existing) return false;
    bucket.delete(name);
    if (existing.isDefault) {
      const next = bucket.entries().next();
      if (!next.done) {
        const [k, v] = next.value;
        bucket.set(k, { ...v, isDefault: true });
      }
    }
    return true;
  }

  async listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return [];
    const now = Math.floor(Date.now() / 1000);
    return [...bucket.entries()].map(([name, doc]) => summarize(name, doc, now));
  }

  async getDefaultTokenName(fbUserId: string): Promise<string | null> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return null;
    for (const [name, doc] of bucket) {
      if (doc.isDefault) return name;
    }
    return null;
  }

  async getDecryptedToken(
    fbUserId: string,
    name?: string,
    serverUrl?: URL,
  ): Promise<string> {
    const tokenName = name ?? (await this.getDefaultTokenName(fbUserId));
    if (!tokenName) {
      throw new Error(`No Meta token registered for user ${fbUserId}`);
    }
    const bucket = this.tokens.get(fbUserId);
    const doc = bucket?.get(tokenName);
    if (!doc) {
      throw new Error(`Meta token "${tokenName}" not found for user ${fbUserId}`);
    }

    return maybeRefresh(doc, fbUserId, tokenName, serverUrl, async (next) => {
      bucket!.set(tokenName, { ...doc, ...next });
    });
  }
}

let activeRepo: MetaTokenRepo = new FirestoreMetaTokenRepo();

export function configureMetaTokenRepo(repo: MetaTokenRepo): void {
  activeRepo = repo;
}

export function getMetaTokenRepo(): MetaTokenRepo {
  return activeRepo;
}

export function resetMetaTokenRepoForTests(): void {
  activeRepo = new FirestoreMetaTokenRepo();
}

export function upsertUser(fbUserId: string, profile: MetaProfile): Promise<void> {
  return activeRepo.upsertUser(fbUserId, profile);
}

export function getUser(fbUserId: string): Promise<UserDoc | null> {
  return activeRepo.getUser(fbUserId);
}

export function saveToken(input: SaveTokenInput): Promise<void> {
  return activeRepo.saveToken(input);
}

export function setDefaultToken(fbUserId: string, name: string): Promise<boolean> {
  return activeRepo.setDefaultToken(fbUserId, name);
}

export function deleteToken(fbUserId: string, name: string): Promise<boolean> {
  return activeRepo.deleteToken(fbUserId, name);
}

export function listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
  return activeRepo.listTokens(fbUserId);
}

export function getDefaultTokenName(fbUserId: string): Promise<string | null> {
  return activeRepo.getDefaultTokenName(fbUserId);
}

export function getDecryptedToken(
  fbUserId: string,
  name?: string,
  serverUrl?: URL,
): Promise<string> {
  return activeRepo.getDecryptedToken(fbUserId, name, serverUrl);
}
