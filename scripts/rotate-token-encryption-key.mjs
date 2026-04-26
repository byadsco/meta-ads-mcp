#!/usr/bin/env node
// Re-encrypts every Meta token in Firestore from OLD TOKEN_ENCRYPTION_KEY to NEW.
//
// Usage:
//   OLD_KEY=<64-hex> NEW_KEY=<64-hex> [DRY_RUN=1] [PROJECT_ID=byads-dsp] \
//     node scripts/rotate-token-encryption-key.mjs
//
// Behaviour:
//   1. Smoke test: write+roundtrip 2 docs in `_rotation_test`, then clean up.
//   2. Iterate `users/*/meta_tokens/*`, decrypt with OLD, encrypt with NEW, write.
//   3. Verify: re-read each doc, decrypt with NEW, sanity-check plaintext.
//
// Prints only counts and per-doc {name, fbUserId, ok}; never prints plaintext.

import { Firestore } from "@google-cloud/firestore";
import crypto from "node:crypto";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

function parseKey(raw, label) {
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${label} must be 64 hex chars`);
  }
  return Buffer.from(raw, "hex");
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(payload, key) {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ct = Buffer.from(payload.ciphertext, "base64");
  const dec = crypto.createDecipheriv(ALG, key, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return pt.toString("utf8");
}

async function smokeTest(db, oldKey, newKey, dryRun) {
  const colRef = db.collection("_rotation_test");
  const docA = colRef.doc("probe-a");
  const docB = colRef.doc("probe-b");
  const sampleA = "EAA-sample-token-A-" + Date.now();
  const sampleB = "system-user-token-B-" + Date.now();

  await docA.set({ encryptedToken: encrypt(sampleA, oldKey) });
  await docB.set({ encryptedToken: encrypt(sampleB, oldKey) });

  for (const ref of [docA, docB]) {
    const snap = await ref.get();
    const oldPayload = snap.data().encryptedToken;
    const pt = decrypt(oldPayload, oldKey);
    const newPayload = encrypt(pt, newKey);
    await ref.update({ encryptedToken: newPayload });
    const verify = await ref.get();
    const back = decrypt(verify.data().encryptedToken, newKey);
    if (back !== pt) throw new Error(`Smoke test failed for ${ref.id}`);
  }

  // Cleanup
  if (!dryRun) {
    await docA.delete();
    await docB.delete();
  }
  console.log("Smoke test: OK (probe-a, probe-b round-tripped)");
}

async function main() {
  const oldKey = parseKey(process.env.OLD_KEY, "OLD_KEY");
  const newKey = parseKey(process.env.NEW_KEY, "NEW_KEY");
  const dryRun = process.env.DRY_RUN === "1";
  const projectId = process.env.PROJECT_ID ?? "byads-dsp";

  if (oldKey.equals(newKey)) {
    throw new Error("OLD_KEY and NEW_KEY are identical — nothing to rotate");
  }

  const db = new Firestore({ projectId, ignoreUndefinedProperties: true });

  console.log(`Project: ${projectId}, dryRun=${dryRun}`);
  await smokeTest(db, oldKey, newKey, dryRun);

  console.log("Scanning users/*/meta_tokens/*...");
  const usersSnap = await db.collection("users").get();
  console.log(`users: ${usersSnap.size}`);

  let total = 0;
  let rotated = 0;
  let failed = 0;
  const failures = [];

  for (const userDoc of usersSnap.docs) {
    const tokensSnap = await db
      .collection("users")
      .doc(userDoc.id)
      .collection("meta_tokens")
      .get();
    for (const td of tokensSnap.docs) {
      total++;
      const data = td.data();
      try {
        const pt = decrypt(data.encryptedToken, oldKey);
        const newPayload = encrypt(pt, newKey);
        if (!dryRun) {
          await td.ref.update({
            encryptedToken: newPayload,
            updatedAt: Math.floor(Date.now() / 1000),
          });
          // Verify
          const after = await td.ref.get();
          const verify = decrypt(after.data().encryptedToken, newKey);
          if (verify !== pt) throw new Error("post-write verify mismatch");
        }
        rotated++;
        console.log(` ✓ ${userDoc.id}/${td.id}`);
      } catch (err) {
        failed++;
        failures.push({ user: userDoc.id, name: td.id, error: err.message });
        console.log(` ✗ ${userDoc.id}/${td.id}: ${err.message}`);
      }
    }
  }

  console.log(`\nSummary: total=${total} rotated=${rotated} failed=${failed} dryRun=${dryRun}`);
  if (failures.length) {
    console.log("Failures:", JSON.stringify(failures));
    process.exit(2);
  }

  await db.terminate();
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
