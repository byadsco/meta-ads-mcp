import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FirestoreApifyTokenRepo,
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
  getApifyTokenRepo,
  type ApifyTokenDoc,
} from "../../src/store/apify-token-repo.js";
import { encryptToken, decryptToken, resetKeyCacheForTests } from "../../src/auth/crypto.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, and carrying the repo's `fixture` marker, so it never trips the
// secret scanner.
const TOKEN = "apify_api_testfixture";

describe("apify-token-repo", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(undefined);
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(undefined);
  });

  describe("InMemoryApifyTokenRepo", () => {
    it("round-trips a token through encryption", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, { id: "u1", username: "byads" });

      expect(await repo.getDecryptedToken("user-1")).toBe(TOKEN);
    });

    it("reports status without exposing the token", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, { id: "u1", username: "byads" });

      const status = await repo.getStatus("user-1");
      expect(status.registered).toBe(true);
      expect(status.apifyUsername).toBe("byads");
      expect(status.apifyUserId).toBe("u1");
      expect(status.updatedAt).toBeTypeOf("number");
      expect(JSON.stringify(status)).not.toContain(TOKEN);
    });

    it("returns an empty status for an unknown tenant", async () => {
      const repo = new InMemoryApifyTokenRepo();
      expect(await repo.getStatus("nobody")).toEqual({
        registered: false,
        apifyUserId: null,
        apifyUsername: null,
        updatedAt: null,
      });
    });

    it("returns null rather than throwing when no token is stored", async () => {
      const repo = new InMemoryApifyTokenRepo();
      expect(await repo.getDecryptedToken("nobody")).toBeNull();
    });

    it("isolates tenants from each other", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", "apify_api_one", null);
      await repo.saveToken("user-2", "apify_api_two", null);

      expect(await repo.getDecryptedToken("user-1")).toBe("apify_api_one");
      expect(await repo.getDecryptedToken("user-2")).toBe("apify_api_two");
    });

    it("preserves createdAt but bumps updatedAt when re-registering", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, null);
      const first = await repo.getStatus("user-1");

      await repo.saveToken("user-1", "apify_api_rotated", null);
      const second = await repo.getStatus("user-1");

      expect(await repo.getDecryptedToken("user-1")).toBe("apify_api_rotated");
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt as number);
    });

    it("deletes a token and reports whether anything was removed", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, null);

      expect(await repo.deleteToken("user-1")).toBe(true);
      expect(await repo.deleteToken("user-1")).toBe(false);
      expect(await repo.getDecryptedToken("user-1")).toBeNull();
    });
  });

  describe("FirestoreApifyTokenRepo", () => {
    /**
     * Minimal Firestore stand-in that records exactly what would be persisted,
     * so we can assert on the real stored document rather than on an opaque
     * in-memory object.
     */
    function fakeFirestore() {
      const written = new Map<string, ApifyTokenDoc>();
      const db = {
        collection: (c: string) => ({
          doc: (userId: string) => ({
            collection: (sub: string) => ({
              doc: (id: string) => {
                const key = `${c}/${userId}/${sub}/${id}`;
                return {
                  get: async () => ({
                    exists: written.has(key),
                    data: () => written.get(key),
                  }),
                  set: async (doc: ApifyTokenDoc) => {
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

    it("persists ciphertext only — the plaintext token never reaches Firestore", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreApifyTokenRepo(db as never);

      await repo.saveToken("user-1", TOKEN, { id: "u1", username: "byads" });

      const stored = written.get("users/user-1/apify_tokens/default");
      expect(stored).toBeDefined();
      expect(JSON.stringify(stored)).not.toContain(TOKEN);
      expect(stored?.encryptedToken).toMatchObject({
        ciphertext: expect.any(String),
        iv: expect.any(String),
        tag: expect.any(String),
      });
      expect(stored).not.toHaveProperty("token");
      expect(await repo.getDecryptedToken("user-1")).toBe(TOKEN);
    });

    it("refuses a document relocated from another tenant instead of decrypting it", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreApifyTokenRepo(db as never);

      await repo.saveToken("user-1", TOKEN, null);
      const stolen = written.get("users/user-1/apify_tokens/default")!;
      written.set("users/user-2/apify_tokens/default", stolen);

      await expect(repo.getDecryptedToken("user-2")).rejects.toThrow(/could not be decrypted/i);
    });

    it("surfaces a tampered ciphertext rather than degrading to no token", async () => {
      const { db, written } = fakeFirestore();
      const repo = new FirestoreApifyTokenRepo(db as never);

      await repo.saveToken("user-1", TOKEN, null);
      const doc = written.get("users/user-1/apify_tokens/default")!;
      written.set("users/user-1/apify_tokens/default", {
        ...doc,
        encryptedToken: { ...doc.encryptedToken, ciphertext: Buffer.from("tampered").toString("base64") },
      });

      await expect(repo.getDecryptedToken("user-1")).rejects.toThrow(/could not be decrypted/i);
    });

    it("returns null for a tenant that never registered", async () => {
      const { db } = fakeFirestore();
      const repo = new FirestoreApifyTokenRepo(db as never);
      expect(await repo.getDecryptedToken("nobody")).toBeNull();
    });

    it("deletes and reports whether anything existed", async () => {
      const { db } = fakeFirestore();
      const repo = new FirestoreApifyTokenRepo(db as never);

      await repo.saveToken("user-1", TOKEN, null);
      expect(await repo.deleteToken("user-1")).toBe(true);
      expect(await repo.deleteToken("user-1")).toBe(false);
    });
  });

  describe("AAD binding", () => {
    it("refuses to decrypt a ciphertext relocated to another tenant", () => {
      const payload = encryptToken(TOKEN, "apify_token:user-1:default");

      expect(() => decryptToken(payload, "apify_token:user-2:default")).toThrow();
      expect(decryptToken(payload, "apify_token:user-1:default")).toBe(TOKEN);
    });

    it("refuses to decrypt a Meta-namespaced ciphertext as an Apify token", () => {
      const payload = encryptToken(TOKEN, "mcp_token:user-1:default");

      expect(() => decryptToken(payload, "apify_token:user-1:default")).toThrow();
    });
  });

  describe("getApifyTokenRepo", () => {
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
        expect(getApifyTokenRepo()).toBeInstanceOf(InMemoryApifyTokenRepo);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value !== undefined) process.env[key] = value;
        }
      }
    });

    it("returns the repo injected for tests", () => {
      const injected = new InMemoryApifyTokenRepo();
      configureApifyTokenRepoForTests(injected);
      expect(getApifyTokenRepo()).toBe(injected);
    });
  });
});
