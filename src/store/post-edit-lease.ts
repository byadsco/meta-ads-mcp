import type { Firestore } from "@google-cloud/firestore";
import { getFirestore, isFirestoreEnabled } from "./firestore.js";

// One edit of a post at a time, across server instances: two edits of the
// same post would each move the other's ads. A lease outlives a crashed
// holder by at most LEASE_MS, longer than an edit can take.
const COLLECTION = "post_edit_leases";
const LEASE_MS = 10 * 60 * 1000;

interface Lease {
  holder: string;
  expiresAt: number;
}

interface LeaseStore {
  claim(postId: string, holder: string): Promise<boolean>;
  release(postId: string, holder: string): Promise<void>;
}

class InMemoryLeases implements LeaseStore {
  private readonly leases = new Map<string, Lease>();

  async claim(postId: string, holder: string): Promise<boolean> {
    const lease = this.leases.get(postId);
    if (lease && lease.expiresAt > Date.now()) return false;
    this.leases.set(postId, { holder, expiresAt: Date.now() + LEASE_MS });
    return true;
  }

  async release(postId: string, holder: string): Promise<void> {
    if (this.leases.get(postId)?.holder === holder) this.leases.delete(postId);
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
      if (lease && lease.expiresAt > Date.now()) return false;
      tx.set(ref, { holder, expiresAt: Date.now() + LEASE_MS });
      return true;
    });
  }

  async release(postId: string, holder: string): Promise<void> {
    const ref = this.ref(postId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as Lease).holder === holder) tx.delete(ref);
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

export function resetPostEditLeasesForTests(): void {
  store = undefined;
}
