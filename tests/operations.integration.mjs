import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase integration environment is missing");

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const owner = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `operations-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
let userId;
let accountId;
let projectId;
let originalDataPolicies = [];

function data(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

try {
  const created = data(await service.auth.admin.createUser({ email, password, email_confirm: true }), "create owner");
  userId = created.user.id;
  data(await owner.auth.signInWithPassword({ email, password }), "sign in owner");
  accountId = data(await service.from("account_memberships").select("account_id").eq("user_id", userId).single(), "load account").account_id;
  const project = data(await owner.rpc("create_account_project", {
    p_account_id: accountId,
    project_name: `Operations ${suffix}`,
    project_description: "Operations integration",
    project_logo_url: null,
    enabled_service_slugs: [],
  }), "create project");
  projectId = project.id;

  originalDataPolicies = data(await service.from("rate_limit_policies").select("id,requests").eq("service", "data"), "load data limits");
  data(await service.from("rate_limit_policies").update({ requests: 1 }).eq("service", "data"), "lower data limits");
  const first = data(await service.rpc("consume_data_rate_limit", { p_project_id: projectId, p_actor_id: userId, p_ip: "198.51.100.40" }), "first request");
  const second = data(await service.rpc("consume_data_rate_limit", { p_project_id: projectId, p_actor_id: userId, p_ip: "198.51.100.40" }), "second request");
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  const blocked = data(await service.from("audit_events").select("metadata,ip").eq("action", "security.rate_limit.blocked").eq("project_id", projectId), "load rate audit");
  assert(blocked.length >= 1);
  assert.equal(JSON.stringify(blocked).includes("198.51.100.40"), true);
  assert.equal(JSON.stringify(blocked).includes(password), false);

  data(await owner.rpc("record_security_session_event", { p_event: "sign_in" }), "record sign in");
  const authAudit = data(await service.from("audit_events").select("metadata").eq("action", "auth.sign_in").eq("actor_id", userId), "load auth audit");
  assert.equal(authAudit.length, 1);
  assert.equal(JSON.stringify(authAudit).includes(email), false);

  const policyRows = data(await owner.from("rate_limit_policies").select("id"), "owner policy visibility");
  assert.equal(policyRows.length, 0);
  const forbiddenInsert = await owner.from("operational_checks").insert({ service: "spoofed", status: "healthy" });
  assert(forbiddenInsert.error, "ordinary users must not write operational evidence");

  console.log("Operations control plane integration passed");
} finally {
  for (const policy of originalDataPolicies) await service.from("rate_limit_policies").update({ requests: policy.requests }).eq("id", policy.id);
  if (projectId) await service.from("projects").delete().eq("id", projectId);
  if (accountId) await service.from("accounts").delete().eq("id", accountId);
  if (userId) await service.auth.admin.deleteUser(userId);
}
