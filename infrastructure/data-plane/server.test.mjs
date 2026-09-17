import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "./server.js";

const key = "a".repeat(64);

test("AES-256-GCM secret encryption round-trips without plaintext storage", () => {
  const value = "spaces-private-value";
  const encrypted = encryptSecret(value, key);
  assert.notEqual(encrypted.ciphertext, value);
  assert.equal(JSON.stringify(encrypted).includes(value), false);
  assert.equal(decryptSecret({ ...encrypted, auth_tag: encrypted.authTag }, key), value);
});

test("modified ciphertext is rejected", () => {
  const encrypted = encryptSecret("spaces-private-value", key);
  encrypted.ciphertext = Buffer.from("modified").toString("base64");
  assert.throws(() => decryptSecret({ ...encrypted, auth_tag: encrypted.authTag }, key));
});
