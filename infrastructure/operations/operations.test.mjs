import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { decryptFile, encryptFile } from "./backup.mjs";
import { safeCode } from "./common.mjs";
import { healthStatus } from "./monitor.mjs";

test("backup encryption authenticates and restores the archive", async () => {
  process.env.SPACES_BACKUP_ENCRYPTION_KEY = "c".repeat(64);
  const directory = await mkdtemp(join(tmpdir(), "spaces-backup-test-"));
  try {
    const source = join(directory, "source.tar");
    const encrypted = join(directory, "backup.spcbak");
    const restored = join(directory, "restored.tar");
    await writeFile(source, "private backup payload");
    await encryptFile(source, encrypted);
    assert.equal((await readFile(encrypted, "utf8")).includes("private backup payload"), false);
    await decryptFile(encrypted, restored);
    assert.equal(await readFile(restored, "utf8"), "private backup payload");
    const modified = await readFile(encrypted);
    modified[30] ^= 1;
    await writeFile(encrypted, modified);
    await assert.rejects(() => decryptFile(encrypted, restored));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("monitor classifies slow and unavailable dependencies", () => {
  assert.equal(healthStatus(true, 100), "healthy");
  assert.equal(healthStatus(true, 4000), "degraded");
  assert.equal(healthStatus(false, 10), "down");
});

test("operational failures expose stable codes instead of secret-bearing messages", () => {
  assert.equal(safeCode(new Error("pg_dump failed for postgresql://secret")), "database_dump_failed");
  assert.equal(safeCode(new Error("request timeout with token secret")), "timeout");
});
