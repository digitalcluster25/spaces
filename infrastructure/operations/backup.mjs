import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { recordAudit, required, safeCode, sendAlert, sha256, supabase } from "./common.mjs";

const exec = promisify(execFile);
const magic = Buffer.from("SPCBKP01");

function key() {
  const value = Buffer.from(required("SPACES_BACKUP_ENCRYPTION_KEY"), "hex");
  if (value.length !== 32) throw new Error("Invalid backup encryption key");
  return value;
}

export async function encryptFile(source, destination) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = await readFile(source);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  await writeFile(destination, Buffer.concat([magic, iv, encrypted, cipher.getAuthTag()]), { mode: 0o600 });
}

export async function decryptFile(source, destination) {
  const data = await readFile(source);
  if (!data.subarray(0, magic.length).equals(magic)) throw new Error("Invalid backup archive");
  const iv = data.subarray(magic.length, magic.length + 12);
  const authTag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(authTag);
  await writeFile(destination, Buffer.concat([decipher.update(data.subarray(magic.length + 12, data.length - 16)), decipher.final()]), { mode: 0o600 });
}

async function storageObjects(prefix = "") {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const rows = await supabase("/storage/v1/object/list/project-files", {
      method: "POST",
      body: { prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } },
    });
    for (const row of rows || []) {
      const path = prefix ? `${prefix}/${row.name}` : row.name;
      if (row.id) all.push(path);
      else all.push(...await storageObjects(path));
    }
    if (!rows || rows.length < 1000) break;
  }
  return all;
}

async function backupStorage(directory) {
  const objectDirectory = join(directory, "storage");
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  const objects = await storageObjects();
  const manifest = [];
  for (const name of objects) {
    const response = await fetch(`${required("SUPABASE_URL")}/storage/v1/object/authenticated/project-files/${name.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { apikey: required("SUPABASE_SERVICE_ROLE_KEY"), authorization: `Bearer ${required("SUPABASE_SERVICE_ROLE_KEY")}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("Storage object backup failed");
    const body = Buffer.from(await response.arrayBuffer());
    const destination = join(objectDirectory, name);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, body, { mode: 0o600 });
    manifest.push({ name, bytes: body.length, sha256: sha256(body) });
  }
  return manifest;
}

async function backupConfig(directory) {
  const target = join(directory, "config");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const paths = [
    "/opt/spaces/provisioner.env", "/opt/spaces/billing.env", "/opt/spaces/data-plane.env", "/opt/spaces/mcp-gateway.env",
    "/opt/spaces/docker-compose.yml", "/opt/spaces/nginx.conf", "/opt/outline/.env", "/opt/openseo/.env",
  ];
  for (const source of paths) {
    try { await copyFile(source, join(target, `${source.split("/").filter(Boolean).slice(-2).join("-")}`)); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function dumpDatabase(directory) {
  const args = ["run", "--rm", "-e", `PGPASSWORD=${required("SUPABASE_DB_PASSWORD")}`, "-e", "PGSSLMODE=require",
    "-v", `${directory}:/work`, "postgres:17-alpine", "pg_dump", "--format=custom", "--compress=6", "--no-owner", "--no-acl",
    "--host", required("SUPABASE_DB_HOST"), "--port", process.env.SUPABASE_DB_PORT || "5432",
    "--username", required("SUPABASE_DB_USER"), "--dbname", process.env.SUPABASE_DB_NAME || "postgres", "--file", "/work/database.dump"];
  await exec("docker", args, { timeout: 30 * 60_000, maxBuffer: 10 * 1024 * 1024 });
  return stat(join(directory, "database.dump"));
}

async function verifyBackup(archive, runId) {
  const rows = await supabase("/rest/v1/restore_drills", {
    method: "POST", headers: { prefer: "return=representation" },
    body: { backup_run_id: runId, status: "running" },
  });
  const drill = rows[0];
  const verifyRoot = await mkdtemp("/opt/spaces/backups/.verify-");
  const tarFile = join(verifyRoot, "archive.tar");
  const extracted = join(verifyRoot, "restored");
  await mkdir(extracted, { mode: 0o700 });
  try {
    await decryptFile(archive, tarFile);
    await exec("tar", ["-xf", tarFile, "-C", extracted], { timeout: 120_000 });
    await exec("docker", ["run", "--rm", "-v", `${extracted}:/work:ro`, "postgres:17-alpine", "pg_restore", "--list", "/work/database.dump"], { timeout: 120_000 });
    const { stdout } = await exec("docker", ["run", "--rm", "-v", `${extracted}:/work`, "postgres:17-alpine", "pg_restore", "--data-only", "--table=accounts", "--table=projects", "--table=project_memberships", "--file=/work/critical.sql", "/work/database.dump"], { timeout: 120_000 });
    void stdout;
    const critical = await readFile(join(extracted, "critical.sql"), "utf8");
    if (!critical.includes("COPY public.projects")) throw new Error("Critical table extraction failed");
    const manifest = JSON.parse(await readFile(join(extracted, "manifest.json"), "utf8"));
    for (const item of manifest.objects) {
      const body = await readFile(join(extracted, "storage", item.name));
      if (body.length !== item.bytes || sha256(body) !== item.sha256) throw new Error("Storage checksum failed");
    }
    const drills = await supabase(`/rest/v1/restore_drills?id=eq.${drill.id}`, {
      method: "PATCH", headers: { prefer: "return=representation" },
      body: { status: "passed", checks: { archive_decrypted: true, pg_restore_list: true, critical_tables_extracted: true, storage_objects_verified: manifest.objects.length }, completed_at: new Date().toISOString() },
    });
    return drills?.[0];
  } catch (error) {
    await supabase(`/rest/v1/restore_drills?id=eq.${drill.id}`, {
      method: "PATCH", headers: { prefer: "return=minimal" },
      body: { status: "failed", error_code: safeCode(error), completed_at: new Date().toISOString() },
    }).catch(() => {});
    throw error;
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
  }
}

async function cleanRetention(directory) {
  const retentionMs = Number(process.env.BACKUP_RETENTION_DAYS || 14) * 86_400_000;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".spcbak") && !name.endsWith(".json")) continue;
    const path = join(directory, name);
    if (Date.now() - (await stat(path)).mtimeMs > retentionMs) await rm(path, { force: true });
  }
}

export async function runBackup() {
  const backupRoot = process.env.BACKUP_DIRECTORY || "/opt/spaces/backups";
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  const revision = process.env.DEPLOYED_REVISION || await readFile("/opt/spaces/deployed-revision", "utf8").then((value) => value.trim()).catch(() => null);
  const runs = await supabase("/rest/v1/backup_runs", { method: "POST", headers: { prefer: "return=representation" }, body: { kind: "full", status: "running", revision } });
  const run = runs[0];
  const staging = await mkdtemp(join(backupRoot, ".staging-"));
  const plainTar = join(backupRoot, `.${run.id}.tar`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `spaces-${stamp}-${run.id}.spcbak`;
  const archive = join(backupRoot, archiveName);
  try {
    const database = await dumpDatabase(staging);
    const objects = await backupStorage(staging);
    await backupConfig(staging);
    const manifest = { version: 1, run_id: run.id, created_at: new Date().toISOString(), database_sha256: sha256(await readFile(join(staging, "database.dump"))), objects };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await exec("tar", ["-cf", plainTar, "-C", staging, "."], { timeout: 120_000 });
    await chmod(plainTar, 0o600);
    await encryptFile(plainTar, archive);
    const archiveBody = await readFile(archive);
    const archiveHash = sha256(archiveBody);
    await writeFile(`${archive}.json`, JSON.stringify({ run_id: run.id, archive: archiveName, sha256: archiveHash, bytes: archiveBody.length, created_at: manifest.created_at }, null, 2), { mode: 0o600 });
    await verifyBackup(archive, run.id);
    await supabase(`/rest/v1/backup_runs?id=eq.${run.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: {
      status: "completed", archive_name: archiveName, archive_sha256: archiveHash, size_bytes: archiveBody.length,
      database_bytes: database.size, object_count: objects.length, completed_at: new Date().toISOString(), details: { encryption: "aes-256-gcm", restore_drill: "passed" },
    } });
    await cleanRetention(backupRoot);
    await recordAudit("operations.backup.completed", "backup_run", run.id, { archive_sha256: archiveHash, object_count: objects.length, restore_drill: "passed" });
    console.log(JSON.stringify({ backup: "ok", runId: run.id, objects: objects.length, encrypted: true, restoreDrill: "passed" }));
  } catch (error) {
    const code = safeCode(error);
    await supabase(`/rest/v1/backup_runs?id=eq.${run.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: { status: "failed", error_code: code, completed_at: new Date().toISOString() } }).catch(() => {});
    await sendAlert("Spaces backup failed", `Backup ${run.id} failed with code ${code}. No secret values were logged.`).catch(() => false);
    await recordAudit("operations.backup.failed", "backup_run", run.id, { error_code: code }).catch(() => {});
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(plainTar, { force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) runBackup().catch(() => {
  console.error(JSON.stringify({ backup: "failed", code: "backup_failed" }));
  process.exitCode = 1;
});
