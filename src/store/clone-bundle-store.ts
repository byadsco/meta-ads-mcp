import { Firestore } from "@google-cloud/firestore";
import { getFirestore, isFirestoreEnabled } from "./firestore.js";
import { logger } from "../utils/logger.js";

export interface CloneBundleCreatedResources {
  adSetId?: string;
  // On the native-copy clone path, ad creatives are duplicated server-side by
  // Meta and are not separately tracked here; creativeIds only collects the
  // creatives minted locally when applying a creative_overrides swap. adIds
  // holds the copied ad ids and is the primary partial-state ledger for cleanup.
  creativeIds: string[];
  adIds: string[];
}

export interface CloneBundleRecord {
  cacheKey: string;
  signature: string;
  state: "in_progress" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  createdResources: CloneBundleCreatedResources;
  lastError?: string;
}

const COLLECTION = "clone_bundle_operations";
export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;

class InMemoryStore {
  private readonly map = new Map<string, CloneBundleRecord>();

  async getDoc(key: string): Promise<CloneBundleRecord | undefined> {
    return this.map.get(key);
  }

  async claim(key: string, signature: string): Promise<{ status: "claimed" | "duplicate"; existing?: CloneBundleRecord }> {
    const existing = this.map.get(key);
    if (existing) {
      if (existing.state === "in_progress" && Date.now() - existing.startedAt > STALE_IN_PROGRESS_MS) {
        // Stale lock — allow re-claim.
      } else {
        return { status: "duplicate", existing };
      }
    }
    this.map.set(key, {
      cacheKey: key,
      signature,
      state: "in_progress",
      startedAt: Date.now(),
      createdResources: { creativeIds: [], adIds: [] },
    });
    return { status: "claimed" };
  }

  async update(key: string, partial: Partial<CloneBundleRecord>): Promise<void> {
    const existing = this.map.get(key);
    if (!existing) return;
    this.map.set(key, { ...existing, ...partial });
  }
}

class FirestoreStore {
  constructor(private readonly db: Firestore) {}

  private docRef(key: string) {
    return this.db.collection(COLLECTION).doc(encodeURIComponent(key));
  }

  async getDoc(key: string): Promise<CloneBundleRecord | undefined> {
    const snap = await this.docRef(key).get();
    return snap.exists ? (snap.data() as CloneBundleRecord) : undefined;
  }

  async claim(key: string, signature: string): Promise<{ status: "claimed" | "duplicate"; existing?: CloneBundleRecord }> {
    const ref = this.docRef(key);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = snap.data() as CloneBundleRecord;
        const isStaleInFlight =
          existing.state === "in_progress" &&
          Date.now() - existing.startedAt > STALE_IN_PROGRESS_MS;
        if (!isStaleInFlight) {
          return { status: "duplicate", existing };
        }
        logger.warn({ cacheKey: key, startedAt: existing.startedAt }, "Reclaiming stale clone bundle lock");
      }
      const fresh: CloneBundleRecord = {
        cacheKey: key,
        signature,
        state: "in_progress",
        startedAt: Date.now(),
        createdResources: { creativeIds: [], adIds: [] },
      };
      tx.set(ref, fresh);
      return { status: "claimed" };
    });
  }

  async update(key: string, partial: Partial<CloneBundleRecord>): Promise<void> {
    await this.docRef(key).set(partial, { merge: true });
  }
}

export interface CloneBundleStore {
  getDoc(key: string): Promise<CloneBundleRecord | undefined>;
  claim(key: string, signature: string): Promise<{ status: "claimed" | "duplicate"; existing?: CloneBundleRecord }>;
  update(key: string, partial: Partial<CloneBundleRecord>): Promise<void>;
}

let cachedStore: CloneBundleStore | undefined;

export function getCloneBundleStore(): CloneBundleStore {
  if (cachedStore) return cachedStore;
  cachedStore = isFirestoreEnabled() ? new FirestoreStore(getFirestore()) : new InMemoryStore();
  return cachedStore;
}

export function resetCloneBundleStoreForTests(): void {
  cachedStore = undefined;
}
