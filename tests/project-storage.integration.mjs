import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;

if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase integration environment is missing");

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const users = [];
const projects = [];

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function createOwner(label) {
  const email = `storage-${label}-${suffix}@example.com`;
  const password = `Spaces-${label}-${suffix}-Aa1!`;
  const created = requireData(await service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
  users.push(created.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  requireData(await client.auth.signInWithPassword({ email, password }), `sign in ${label}`);
  const membership = requireData(await service.from("account_memberships").select("account_id").eq("user_id", created.user.id).eq("role", "owner").single(), `load ${label} account`);
  requireData(await service.from("account_limit_overrides").upsert({ account_id: membership.account_id, key: "active_projects", value: 3, reason: "Storage integration test" }), `raise ${label} limit`);
  const project = requireData(await client.rpc("create_account_project", {
    p_account_id: membership.account_id,
    project_name: `Storage ${label} ${suffix}`,
    project_description: "Storage integration test",
    project_logo_url: null,
    enabled_service_slugs: [],
  }), `create ${label} project`);
  projects.push(project.id);
  return { client, userId: created.user.id, projectId: project.id };
}

try {
  const first = await createOwner("first");
  const second = await createOwner("second");
  const embedding = `[${[1, ...Array(1535).fill(0)].join(",")}]`;

  const knowledge = requireData(await first.client.rpc("upsert_project_knowledge", {
    p_project_id: first.projectId,
    p_id: null,
    p_title: "Tenant memory",
    p_content: "A private launch checklist for the first project",
    p_source_type: "agent",
    p_source_id: "integration",
    p_service_slug: "spaces",
    p_metadata: { safe: true },
    p_embedding: embedding,
    p_embedding_model: "integration-1536",
  }), "save vector knowledge");
  assert.equal(knowledge.project_id, first.projectId);

  const matches = requireData(await first.client.rpc("search_project_knowledge", {
    p_project_id: first.projectId,
    p_query: "launch checklist",
    p_embedding: embedding,
    p_limit: 5,
  }), "search vector knowledge");
  assert.equal(matches[0].id, knowledge.id);
  assert(matches[0].score > 0.99);

  const crossKnowledge = await second.client.rpc("search_project_knowledge", {
    p_project_id: first.projectId,
    p_query: "launch",
    p_embedding: null,
    p_limit: 5,
  });
  assert(crossKnowledge.error, "another project must not search private knowledge");

  const invalidFile = await first.client.rpc("reserve_project_file", {
    p_project_id: first.projectId,
    p_file_name: "payload.exe",
    p_mime_type: "application/octet-stream",
    p_size_bytes: 10,
    p_service_slug: "spaces",
  });
  assert(invalidFile.error, "executable uploads must be rejected");

  const fileBody = new Blob(["private project document"], { type: "text/plain" });
  const reserved = requireData(await first.client.rpc("reserve_project_file", {
    p_project_id: first.projectId,
    p_file_name: "private.txt",
    p_mime_type: "text/plain",
    p_size_bytes: fileBody.size,
    p_service_slug: "spaces",
  }), "reserve private file");
  requireData(await first.client.storage.from("project-files").upload(reserved.object_path, fileBody, { contentType: "text/plain" }), "upload private file");
  requireData(await first.client.rpc("complete_project_file", { p_file_id: reserved.id, p_sha256: "a".repeat(64) }), "complete private file");
  const signed = requireData(await first.client.storage.from("project-files").createSignedUrl(reserved.object_path, 60), "sign private file");
  assert.match(signed.signedUrl, /token=/);
  const otherFile = await second.client.storage.from("project-files").createSignedUrl(reserved.object_path, 60);
  assert(otherFile.error, "another project must not sign a private file URL");

  const storedSecret = requireData(await service.rpc("store_project_secret_ciphertext", {
    p_project_id: first.projectId,
    p_secret_id: null,
    p_name: "INTEGRATION_API_KEY",
    p_kind: "api_key",
    p_service_slug: "spaces",
    p_description: "Encrypted integration value",
    p_ciphertext: Buffer.from("ciphertext-only").toString("base64"),
    p_iv: Buffer.from("123456789012").toString("base64"),
    p_auth_tag: Buffer.from("1234567890123456").toString("base64"),
    p_actor_id: first.userId,
  }), "store encrypted secret");
  assert.equal(storedSecret.version, 1);
  const visibleMetadata = requireData(await first.client.from("project_secret_metadata").select("name,status,version").eq("id", storedSecret.id).single(), "read secret metadata");
  assert.equal(visibleMetadata.name, "INTEGRATION_API_KEY");
  const ciphertext = await first.client.from("project_secret_versions").select("*").eq("secret_id", storedSecret.id);
  assert(ciphertext.error, "ciphertext table must be unavailable to browsers");
  const crossSecret = requireData(await second.client.from("project_secret_metadata").select("id").eq("id", storedSecret.id), "cross-project secret metadata query");
  assert.equal(crossSecret.length, 0);
  requireData(await service.rpc("set_project_secret_status", { p_secret_id: storedSecret.id, p_status: "disabled", p_actor_id: first.userId }), "disable secret");

  const audit = requireData(await service.from("audit_events").select("metadata").eq("target_id", storedSecret.id).order("created_at"), "load secret audit");
  assert.equal(JSON.stringify(audit).includes("ciphertext-only"), false);
  assert.equal(JSON.stringify(audit).includes("123456789012"), false);

  requireData(await first.client.storage.from("project-files").remove([reserved.object_path]), "remove private file");
  requireData(await first.client.rpc("delete_project_file", { p_file_id: reserved.id }), "delete file metadata");
  requireData(await first.client.rpc("delete_project_knowledge", { p_project_id: first.projectId, p_document_id: knowledge.id }), "delete knowledge");
  console.log("Project storage integration passed");
} finally {
  for (const projectId of projects) await service.from("projects").delete().eq("id", projectId);
  for (const userId of users) await service.auth.admin.deleteUser(userId);
}
