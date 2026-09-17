import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase integration environment is missing");
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Spaces-${suffix}-Aa1!`;
const normalEmail = `spaces-owner-${suffix}@example.com`;
const superadminEmail = "digitalcluster25@gmail.com";
const createdUserIds = [];

function userClient() {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function createUser(email) {
  const data = requireData(await service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${email}`);
  createdUserIds.push(data.user.id);
  return data.user;
}

async function ensureSuperadmin() {
  const listed = requireData(await service.auth.admin.listUsers({ page: 1, perPage: 1000 }), "list users");
  const existing = listed.users.find((user) => user.email?.toLowerCase() === superadminEmail);
  if (!existing) return requireData(await service.auth.admin.createUser({ email: superadminEmail, password, email_confirm: true }), "create superadmin").user;
  requireData(await service.auth.admin.updateUserById(existing.id, { password, email_confirm: true }), "update superadmin password");
  return existing;
}

async function signIn(email) {
  const client = userClient();
  requireData(await client.auth.signInWithPassword({ email, password }), `sign in ${email}`);
  return client;
}

try {
  const superadmin = await ensureSuperadmin();
  const superadminAccount = requireData(await service.from("account_memberships").select("account_id").eq("user_id", superadmin.id).eq("role", "owner").single(), "load superadmin account");
  const superadminClient = await signIn(superadminEmail);

  const hiddenMemberships = requireData(await superadminClient.from("account_memberships").select("account_id"), "read memberships without MFA");
  assert.equal(hiddenMemberships.length, 0, "superadmin AAL1 session must not read account membership");

  const forbiddenProject = await superadminClient.rpc("create_account_project", {
    p_account_id: superadminAccount.account_id,
    project_name: `Forbidden ${suffix}`,
    project_description: null,
    project_logo_url: null,
    enabled_service_slugs: [],
  });
  assert(forbiddenProject.error, "superadmin AAL1 session must not create projects");

  const normal = await createUser(normalEmail);
  const normalAccount = requireData(await service.from("account_memberships").select("account_id").eq("user_id", normal.id).eq("role", "owner").single(), "load normal account");
  const normalClient = await signIn(normalEmail);
  const normalProject = requireData(await normalClient.rpc("create_account_project", {
    p_account_id: normalAccount.account_id,
    project_name: `Allowed ${suffix}`,
    project_description: null,
    project_logo_url: null,
    enabled_service_slugs: [],
  }), "normal owner creates project");
  assert.equal(normalProject.owner_id, normal.id);

  console.log("superadmin MFA integration passed");
} finally {
  if (createdUserIds.length) await service.from("accounts").delete().in("owner_id", createdUserIds);
  for (const userId of createdUserIds) await service.auth.admin.deleteUser(userId);
}
