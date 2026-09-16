import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import defaults from "../harness/defaults.json" with { type: "json" };

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;

if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase integration environment is missing");

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Spaces-${suffix}-Aa1!`;
const identities = ["owner", "member", "stranger"].map((name) => ({
  name,
  email: `spaces-harness-${name}-${suffix}@example.com`,
  id: "",
}));
let projectId = "";
let otherProjectId = "";
let createdTemplateId = "";

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function signIn(email) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  requireData(await client.auth.signInWithPassword({ email, password }), `sign in ${email}`);
  return client;
}

try {
  for (const identity of identities) {
    const created = requireData(await service.auth.admin.createUser({
      email: identity.email,
      password,
      email_confirm: true,
    }), `create ${identity.name}`);
    identity.id = created.user.id;
  }

  const existingTemplate = requireData(await service.from("harness_templates").select("id").eq("key", "spaces-core").maybeSingle(), "find Harness template");
  if (!existingTemplate) {
    const template = requireData(await service.from("harness_templates").insert({
      key: "spaces-core",
      name: "Spaces Harness",
      description: "Integration test template",
      status: "published",
      created_by: identities[0].id,
    }).select().single(), "create Harness template");
    createdTemplateId = template.id;
    requireData(await service.from("harness_versions").insert({
      template_id: template.id,
      version: 1,
      admin_config: defaults,
      schema_version: 1,
      git_revision: "abcdef0",
      status: "published",
      test_report: { passed: true },
      created_by: identities[0].id,
      published_at: new Date().toISOString(),
    }), "create Harness admin version");
  }

  const ownerClient = await signIn(identities[0].email);
  const memberClient = await signIn(identities[1].email);
  const strangerClient = await signIn(identities[2].email);
  const ownerAccount = requireData(await service.from("account_memberships").select("account_id").eq("user_id", identities[0].id).eq("role", "owner").single(), "load owner account");
  const strangerAccount = requireData(await service.from("account_memberships").select("account_id").eq("user_id", identities[2].id).eq("role", "owner").single(), "load stranger account");

  const project = requireData(await ownerClient.rpc("create_account_project", {
    p_account_id: ownerAccount.account_id,
    project_name: `Harness ${suffix}`,
    project_description: "Harness versioning integration test",
    project_logo_url: null,
    enabled_service_slugs: [],
  }), "create project");
  projectId = project.id;

  const otherProject = requireData(await strangerClient.rpc("create_account_project", {
    p_account_id: strangerAccount.account_id,
    project_name: `Harness other ${suffix}`,
    project_description: "Cross-project isolation test",
    project_logo_url: null,
    enabled_service_slugs: [],
  }), "create other project");
  otherProjectId = otherProject.id;

  requireData(await service.from("project_memberships").insert({
    project_id: projectId,
    user_id: identities[1].id,
    role: "member",
    status: "active",
  }), "add member");

  const initialHistory = requireData(await ownerClient.rpc("list_project_harness_versions", { p_project_id: projectId }), "load initial history");
  assert.equal(initialHistory.length, 1);
  assert.equal(initialHistory[0].is_active, true);

  const preview = requireData(await ownerClient.rpc("preview_harness_user_config", {
    p_project_id: projectId,
    p_user_config: {
      objectives: "Ship tested Harness versioning",
      security: { tenant_isolation: false },
      unsupported_field: "ignored",
    },
  }), "preview config");
  assert.equal(preview.evaluation_report.passed, true);
  assert.equal(preview.user_config.objectives, "Ship tested Harness versioning");
  assert.equal("security" in preview.user_config, false);
  assert.equal(preview.conflict_report.length, 2);

  const memberPreview = await memberClient.rpc("preview_harness_user_config", {
    p_project_id: projectId,
    p_user_config: { objectives: "Member write" },
  });
  assert(memberPreview.error, "member must not preview a publishable owner configuration");

  const invalidPublish = await ownerClient.rpc("publish_harness_user_config", {
    p_project_id: projectId,
    p_user_config: { memory_notes: "password=never-store-this-secret-value" },
  });
  assert(invalidPublish.error, "configuration containing a secret must not be activated");
  const unchanged = requireData(await ownerClient.rpc("list_project_harness_versions", { p_project_id: projectId }), "check rejected publish");
  assert.equal(unchanged.length, 1);

  const published = requireData(await ownerClient.rpc("publish_harness_user_config", {
    p_project_id: projectId,
    p_user_config: preview.user_config,
  }), "publish config");
  assert.equal(published.sequence, 2);
  assert.equal(published.evaluation_report.passed, true);

  const hiddenHistory = await strangerClient.rpc("list_project_harness_versions", { p_project_id: projectId });
  assert(hiddenHistory.error, "another project must not read Harness history");
  const crossProjectRollback = await strangerClient.rpc("rollback_harness_user_config", {
    p_project_id: otherProjectId,
    p_version_id: published.id,
  });
  assert(crossProjectRollback.error, "a version from another project must not be restored");

  const rolledBack = requireData(await ownerClient.rpc("rollback_harness_user_config", {
    p_project_id: projectId,
    p_version_id: initialHistory[0].id,
  }), "rollback config");
  assert.equal(rolledBack.sequence, 3);
  assert.equal(rolledBack.action, "rollback");
  assert.equal(rolledBack.source_version_id, initialHistory[0].id);

  const settings = requireData(await service.from("project_harness_settings").select("active_version_id,active_user_version_id,user_config").eq("project_id", projectId).single(), "load settings");
  const activeAdmin = requireData(await service.from("harness_versions").select("*").eq("id", settings.active_version_id).single(), "load admin version");
  const templateVersions = requireData(await service.from("harness_versions").select("version").eq("template_id", activeAdmin.template_id).order("version", { ascending: false }).limit(1), "load max admin version");
  const offeredAdmin = requireData(await service.from("harness_versions").insert({
    template_id: activeAdmin.template_id,
    version: templateVersions[0].version + 1,
    admin_config: activeAdmin.admin_config,
    schema_version: 1,
    git_revision: "abcdef1",
    status: "published",
    test_report: activeAdmin.test_report,
    created_by: identities[0].id,
    published_at: new Date().toISOString(),
  }).select().single(), "create offered admin version");
  requireData(await service.from("project_harness_settings").update({ offered_version_id: offeredAdmin.id }).eq("project_id", projectId), "offer admin version");
  requireData(await ownerClient.rpc("accept_harness_version", { p_project_id: projectId }), "accept admin version");

  const finalHistory = requireData(await ownerClient.rpc("list_project_harness_versions", { p_project_id: projectId }), "load final history");
  assert.equal(finalHistory.length, 4);
  assert.equal(finalHistory[0].action, "admin_update");
  assert.equal(finalHistory[0].admin_version_id, offeredAdmin.id);
  assert.equal(finalHistory[0].is_active, true);
  assert.equal(finalHistory.filter((version) => version.is_active).length, 1);

  console.log("Harness versioning integration passed");
} finally {
  if (projectId) await service.from("projects").delete().eq("id", projectId);
  if (otherProjectId) await service.from("projects").delete().eq("id", otherProjectId);
  if (createdTemplateId) await service.from("harness_templates").delete().eq("id", createdTemplateId);
  for (const identity of identities) {
    if (identity.id) await service.from("accounts").delete().eq("owner_id", identity.id);
    if (identity.id) await service.auth.admin.deleteUser(identity.id);
  }
}
