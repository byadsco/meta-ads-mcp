import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  resetKeyCacheForTests,
} from "../../src/auth/crypto.js";

const HEX64 = "0".repeat(63) + "1";

describe("crypto encryptToken / decryptToken", () => {
  const original = process.env.TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = HEX64;
    resetKeyCacheForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = original;
    resetKeyCacheForTests();
  });

  it("roundtrips arbitrary strings", () => {
    const plaintext = "EAA-test-token-fixture-roundtrip";
    const encrypted = encryptToken(plaintext);
    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const a = encryptToken("hello");
    const b = encryptToken("hello");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptToken(a)).toBe("hello");
    expect(decryptToken(b)).toBe("hello");
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptToken("secret");
    const tampered = {
      ...enc,
      ciphertext: Buffer.from(enc.ciphertext, "base64")
        .map((b) => b ^ 0x01)
        .toString("base64"),
    };
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects malformed encryption keys", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "abc";
    resetKeyCacheForTests();
    expect(() => encryptToken("x")).toThrow(/64 hex characters/);
  });

  it("CODE-B1: AAD round-trips when same value supplied on both sides", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(decryptToken(enc, "user-1:byads")).toBe("secret-token");
  });

  it("CODE-B1: rejects ciphertext when a different AAD is supplied (rebind defense)", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(() => decryptToken(enc, "user-2:byads")).toThrow();
    expect(() => decryptToken(enc, "user-1:other-name")).toThrow();
  });

  it("CODE-B1: rejects ciphertext encrypted-with-AAD when decrypted-without-AAD", () => {
    const enc = encryptToken("secret-token", "user-1:byads");
    expect(() => decryptToken(enc)).toThrow();
  });

  it("CODE-B1: legacy ciphertext (no AAD) still decrypts when no AAD is supplied", () => {
    const enc = encryptToken("legacy-token");
    expect(decryptToken(enc)).toBe("legacy-token");
  });
});
