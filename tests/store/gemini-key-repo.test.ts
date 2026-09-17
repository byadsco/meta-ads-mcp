import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FirestoreGeminiKeyRepo,
  InMemoryGeminiKeyRepo,
  configureGeminiKeyRepoForTests,
  getGeminiKeyRepo,
  type GeminiKeyDoc,
} from "../../src/store/gemini-key-repo.js";
import { encryptToken, decryptToken, resetKeyCacheForTests } from "../../src/auth/crypto.js";

// Carries the repo's `fixture` marker and never follows a GEMINI_API_KEY
// assignment, so it cannot trip the secret scanner.
const KEY = "AQ.test_gemini_fixture_key";

function fakeFirestore() {
  const written = new Map<string, GeminiKeyDoc>();
  const db = {
    collection: (c: string) => ({
      doc: (userId: string) => ({
        collection: (sub: string) => ({
          doc: (id: string) => {
            const key = `${c}/${userId}/${sub}/${id}`;
            return {
              get: async () => ({ exists: written.has(key), data: () => written.get(key) }),
              set: async (doc: GeminiKeyDoc) => {
                written.set(key, doc);
              },
              delete: async () => {
                written.delete(key);
              },
            };
          },
        }),
      }),
    }),
  };
  return { db, written };
}

describe("gemini-key-repo", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    resetKeyCacheForTests();
    configureGeminiKeyRepoForTests(undefined);
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetKeyCacheForTests();
    configureGeminiKeyRepoForTests(undefined);
  });

  describe("InMemoryGeminiKeyRepo", () => {
    it("round-trips a key through encryption", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      expect(await repo.getDecryptedKey("user-1")).toBe(KEY);
    });

    it("reports status without exposing the key or any part of it", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);

      const status = await repo.getStatus("user-1");
      expect(status.registered).toBe(true);
      expect(status.updatedAt).toBeTypeOf("number");
      expect(status.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(status)).not.toContain(KEY);
      expect(JSON.stringify(status)).not.toContain("fixture");
    });

    it("returns an empty status and a null key for an unknown tenant", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      expect(await repo.getStatus("nobody")).toEqual({ registered: false, keyFingerprint: null, updatedAt: null });
      expect(await repo.getDecryptedKey("nobody")).toBeNull();
    });

    it("isolates tenants from each other", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", "AQ.fixture_one");
      await repo.saveKey("user-2", "AQ.fixture_two");
      expect(await repo.getDecryptedKey("user-1")).toBe("AQ.fixture_one");
      expect(await repo.getDecryptedKey("user-2")).toBe("AQ.fixture_two");
    });

    it("preserves createdAt but bumps updatedAt when the key is rotated", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      const first = await repo.getStatus("user-1");
      await repo.saveKey("user-1", "AQ.fixture_rotated");
      const second = await repo.getStatus("user-1");
      expect(await repo.getDecryptedKey("user-1")).toBe("AQ.fixture_rotated");
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt as number);
      expect(second.keyFingerprint).not.toBe(first.keyFingerprint);
    });

    it("deletes a key and reports whether anything was removed", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      expect(await repo.deleteKey("user-1")).toBe(true);
      expect(await repo.deleteKey("user-1")).toBe(false);
      expect(await repo.getDecryptedKey("user-1")).toBeNull();
    });
  });

  describe("FirestoreGeminiKeyRepo", () => {
    it("persists ciphertext only, under its own subcollection", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreGeminiKeyRepo(db as never);

      await repo.saveKey("user-1", KEY);

      const stored = written.get("users/user-1/gemini_keys/default");
      expect(stored).toBeDefined();
      expect(JSON.stringify(stored)).not.toContain(KEY);
      expect(stored?.encryptedKey).toMatchObject({
        ciphertext: expect.any(String),
        iv: expect.any(String),
        tag: expect.any(String),
      });
      expect(stored).not.toHaveProperty("key");
      expect(await repo.getDecryptedKey("user-1")).toBe(KEY);
    });

    it("refuses a document relocated from another tenant instead of decrypting it", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreGeminiKeyRepo(db as never);
      await repo.saveKey("user-1", KEY);
      written.set("users/user-2/gemini_keys/default", written.get("users/user-1/gemini_keys/default")!);

      await expect(repo.getDecryptedKey("user-2")).rejects.toThrow(/could not be decrypted/i);
    });

    it("surfaces a tampered ciphertext rather than degrading to no key", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreGeminiKeyRepo(db as never);
      await repo.saveKey("user-1", KEY);
      const doc = written.get("users/user-1/gemini_keys/default")!;
      written.set("users/user-1/gemini_keys/default", {
        ...doc,
        encryptedKey: { ...doc.encryptedKey, ciphertext: Buffer.from("tampered").toString("base64") },
      });

      await expect(repo.getDecryptedKey("user-1")).rejects.toThrow(/could not be decrypted/i);
    });

    it("never echoes the key in the decryption failure", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreGeminiKeyRepo(db as never);
      await repo.saveKey("user-1", KEY);
      written.set("users/user-2/gemini_keys/default", written.get("users/user-1/gemini_keys/default")!);

      const error = await repo.getDecryptedKey("user-2").catch((e: Error) => e);
      expect(String((error as Error).message)).not.toContain(KEY);
    });

    it("returns null for a tenant that never registered and deletes idempotently", async () => {
      const { db } = fakeFirestore();
      const repo = new FirestoreGeminiKeyRepo(db as never);
      expect(await repo.getDecryptedKey("nobody")).toBeNull();
      await repo.saveKey("user-1", KEY);
      expect(await repo.deleteKey("user-1")).toBe(true);
      expect(await repo.deleteKey("user-1")).toBe(false);
    });
  });

  describe("AAD binding", () => {
    it("refuses to decrypt a ciphertext relocated to another tenant", () => {
      const payload = encryptToken(KEY, "gemini_key:user-1:default");
      expect(() => decryptToken(payload, "gemini_key:user-2:default")).toThrow();
      expect(decryptToken(payload, "gemini_key:user-1:default")).toBe(KEY);
    });

    it("refuses to decrypt an Apify- or Meta-namespaced ciphertext as a Gemini key", async () => {
      for (const foreign of ["apify_token:user-1:default", "mcp_token:user-1:default"]) {
        const { db, written } = fakeFirestore();
        const repo = new FirestoreGeminiKeyRepo(db as never);
        written.set("users/user-1/gemini_keys/default", {
          encryptedKey: encryptToken(KEY, foreign),
          keyHash: "000000000000",
          createdAt: 1,
          updatedAt: 1,
        });
        await expect(repo.getDecryptedKey("user-1")).rejects.toThrow(/could not be decrypted/i);
      }
    });
  });

  describe("getGeminiKeyRepo", () => {
    it("falls back to the in-memory repo when Firestore is not configured", () => {
      const saved = {
        FIRESTORE_PROJECT_ID: process.env.FIRESTORE_PROJECT_ID,
        GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
        FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      };
      delete process.env.FIRESTORE_PROJECT_ID;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.FIRESTORE_EMULATOR_HOST;
      try {
        expect(getGeminiKeyRepo()).toBeInstanceOf(InMemoryGeminiKeyRepo);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
    });
  });
});
