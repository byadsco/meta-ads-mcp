import { getFirestore } from "./firestore.js";

const COLLECTION = "mcp_auth_codes";

export interface AuthCodeEntry {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  fbUserId?: string;
  expiresAt: number;
}

export interface AuthCodesStore {
  set(code: string, entry: AuthCodeEntry): Promise<void>;
  get(code: string): Promise<AuthCodeEntry | undefined>;
  /**
   * Atomically read and delete the entry. Returns the entry if it
   * existed (and only one caller wins the race), undefined otherwise.
   * Used by the OAuth code-exchange path to prevent code reuse under
   * concurrent requests (RFC 6749 §10.5).
   */
  consume(code: string): Promise<AuthCodeEntry | undefined>;
  delete(code: string): Promise<void>;
}

export class FirestoreAuthCodesStore implements AuthCodesStore {
  private get collection() {
    return getFirestore().collection(COLLECTION);
  }

  async set(code: string, entry: AuthCodeEntry): Promise<void> {
    await this.collection.doc(code).set(entry);
  }

  async get(code: string): Promise<AuthCodeEntry | undefined> {
    const snap = await this.collection.doc(code).get();
    if (!snap.exists) return undefined;
    return snap.data() as AuthCodeEntry;
  }

  async consume(code: string): Promise<AuthCodeEntry | undefined> {
    const ref = this.collection.doc(code);
    return getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      return snap.data() as AuthCodeEntry;
    });
  }

  async delete(code: string): Promise<void> {
    await this.collection.doc(code).delete();
  }
}

export class InMemoryAuthCodesStore implements AuthCodesStore {
  private codes = new Map<string, AuthCodeEntry>();

  async set(code: string, entry: AuthCodeEntry): Promise<void> {
    this.codes.set(code, entry);
  }

  async get(code: string): Promise<AuthCodeEntry | undefined> {
    return this.codes.get(code);
  }

  async consume(code: string): Promise<AuthCodeEntry | undefined> {
    // JS event loop is single-threaded so this is atomic by construction;
    // no real race possible in the in-memory implementation.
    const entry = this.codes.get(code);
    if (entry === undefined) return undefined;
    this.codes.delete(code);
    return entry;
  }

  async delete(code: string): Promise<void> {
    this.codes.delete(code);
  }
}
