import type { Firestore } from "@google-cloud/firestore";
import { getFirestore, isFirestoreEnabled } from "./firestore.js";

// One edit of a post at a time, across server instances: two edits of the
// same post would each move the other's ads. A lease outlives a crashed
// holder by at most LEASE_MS, longer than an edit can take.
//
// Each post also counts the edits started on it (its generation). A plan
// binds the count it was previewed at: Meta's reads can lag behind an edit
// that already ran, but this count is read where it is written, so an edit
// started since the preview always shows.
const COLLECTION = "post_edit_leases";
const LEASE_MS = 10 * 60 * 1000;

interface Lease {
  holder: string | null;
  expiresAt: number;
  generation?: number;
}

interface LeaseStore {
  claim(postId: string, holder: string): Promise<boolean>;
  release(postId: string, holder: string): Promise<void>;
  generation(postId: string): Promise<number>;
  advance(postId: string, holder: string): Promise<boolean>;
}

const holds = (lease: Lease | undefined, holder: string) =>
  lease !== undefined && lease.holder === holder && lease.expiresAt > Date.now();

class InMemoryLeases implements LeaseStore {
  private readonly leases = new Map<string, Lease>();

  async claim(postId: string, holder: string): Promise<boolean> {
    const lease = this.leases.get(postId);
    if (lease?.holder && lease.expiresAt > Date.now()) return false;
    this.leases.set(postId, { holder, expiresAt: Date.now() + LEASE_MS, generation: lease?.generation ?? 0 });
    return true;
  }

  async release(postId: string, holder: string): Promise<void> {
    const lease = this.leases.get(postId);
    if (lease?.holder === holder) this.leases.set(postId, { ...lease, holder: null, expiresAt: 0 });
  }

  async generation(postId: string): Promise<number> {
    return this.leases.get(postId)?.generation ?? 0;
  }

  async advance(postId: string, holder: string): Promise<boolean> {
    const lease = this.leases.get(postId);
    if (!holds(lease, holder)) return false;
    lease!.generation = (lease!.generation ?? 0) + 1;
    return true;
  }
}

class FirestoreLeases implements LeaseStore {
  constructor(private readonly db: Firestore) {}

  private ref(postId: string) {
    return this.db.collection(COLLECTION).doc(encodeURIComponent(postId));
  }

  async claim(postId: string, holder: string): Promise<boolean> {
    const ref = this.ref(postId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const lease = snap.exists ? (snap.data() as Lease) : undefined;
      if (lease?.holder && lease.expiresAt > Date.now()) return false;
      tx.set(ref, { holder, expiresAt: Date.now() + LEASE_MS, generation: lease?.generation ?? 0 });
      return true;
    });
  }

  // The document stays: it keeps the post's count of edits.
  async release(postId: string, holder: string): Promise<void> {
    const ref = this.ref(postId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as Lease).holder === holder) tx.update(ref, { holder: null, expiresAt: 0 });
    });
  }

  async generation(postId: string): Promise<number> {
    const snap = await this.ref(postId).get();
    return snap.exists ? ((snap.data() as Lease).generation ?? 0) : 0;
  }

  async advance(postId: string, holder: string): Promise<boolean> {
    const ref = this.ref(postId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const lease = snap.exists ? (snap.data() as Lease) : undefined;
      if (!holds(lease, holder)) return false;
      tx.update(ref, { generation: (lease!.generation ?? 0) + 1 });
      return true;
    });
  }
}

let store: LeaseStore | undefined;

function leases(): LeaseStore {
  store ??= isFirestoreEnabled() ? new FirestoreLeases(getFirestore()) : new InMemoryLeases();
  return store;
}

export function claimPostEditLease(postId: string, holder: string): Promise<boolean> {
  return leases().claim(postId, holder);
}

export function releasePostEditLease(postId: string, holder: string): Promise<void> {
  return leases().release(postId, holder);
}

export function postEditGeneration(postId: string): Promise<number> {
  return leases().generation(postId);
}

// Counts an edit of the post as started, only for the current holder of its
// lease. Every plan previewed before it no longer applies.
export function advancePostEditGeneration(postId: string, holder: string): Promise<boolean> {
  return leases().advance(postId, holder);
}

export function resetPostEditLeasesForTests(db?: Firestore): void {
  store = db ? new FirestoreLeases(db) : undefined;
}
