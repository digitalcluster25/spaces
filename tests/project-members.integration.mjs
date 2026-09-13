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
const identities = ["owner", "member", "stranger"].map((name) => ({
  name,
  email: `spaces-${name}-${suffix}@example.com`,
  id: "",
}));

function userClient() {
  return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email) {
  const client = userClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

let projectId = "";

try {
  for (const identity of identities) {
    const created = requireData(await service.auth.admin.createUser({
      email: identity.email,
      password,
      email_confirm: true,
      user_metadata: { name: `Test ${identity.name}` },
    }), `create ${identity.name}`);
    identity.id = created.user.id;
  }

  const owner = identities[0];
  const member = identities[1];
  const stranger = identities[2];
  const ownerClient = await signIn(owner.email);
  const memberClient = await signIn(member.email);
  const strangerClient = await signIn(stranger.email);

  const ownerMembership = requireData(await service
    .from("account_memberships")
    .select("account_id")
    .eq("user_id", owner.id)
    .eq("role", "owner")
    .single(), "load owner account");

  const project = requireData(await ownerClient.rpc("create_account_project", {
    p_account_id: ownerMembership.account_id,
    project_name: `Integration ${suffix}`,
    project_description: "Project membership integration test",
    project_logo_url: null,
    enabled_service_slugs: ["openseo", "outline"],
  }), "create project");
  projectId = project.id;

  const invitation = requireData(await ownerClient.rpc("create_project_invitation", {
    p_project_id: projectId,
    p_email: member.email,
  }), "create invitation");
  assert.equal(invitation.email, member.email);

  const duplicate = await ownerClient.rpc("create_project_invitation", {
    p_project_id: projectId,
    p_email: member.email,
  });
  assert(duplicate.error, "duplicate invitation must be rejected");

  const deliveries = requireData(await service.rpc("claim_project_invitation_deliveries", { p_limit: 10 }), "claim delivery");
  const delivery = deliveries.find((item) => item.invitation_id === invitation.id);
  assert.equal(delivery?.user_exists, true);
  requireData(await service.rpc("complete_project_invitation_delivery", {
    p_invitation_id: invitation.id,
    p_success: true,
    p_error: null,
  }), "complete delivery");

  const wrongRecipient = await strangerClient.rpc("accept_project_invitation", { p_invitation_id: invitation.id });
  assert(wrongRecipient.error, "another email must not accept the invitation");

  const accepted = requireData(await memberClient.rpc("accept_project_invitation", { p_invitation_id: invitation.id }), "accept invitation");
  assert.equal(accepted.account_id, ownerMembership.account_id);
  assert.equal(accepted.project_id, projectId);

  const memberAccess = requireData(await memberClient.rpc("get_project_access", { p_project_id: projectId }), "member access");
  assert.equal(memberAccess.role, "member");
  assert.equal(memberAccess.invitations.length, 0);
  assert(memberAccess.members.some((item) => item.user_id === member.id));

  const forbiddenChange = await memberClient.rpc("set_project_service_enabled", {
    p_project_id: projectId,
    p_service_slug: "openseo",
    p_enabled: false,
  });
  assert(forbiddenChange.error, "member must not change project services");

  requireData(await ownerClient.rpc("remove_project_member", {
    p_project_id: projectId,
    p_user_id: member.id,
  }), "remove member");

  const removedProjectMembership = requireData(await service
    .from("project_memberships")
    .select("status")
    .eq("project_id", projectId)
    .eq("user_id", member.id)
    .single(), "check project membership");
  const removedAccountMembership = requireData(await service
    .from("account_memberships")
    .select("status")
    .eq("account_id", ownerMembership.account_id)
    .eq("user_id", member.id)
    .single(), "check account membership");
  assert.equal(removedProjectMembership.status, "archived");
  assert.equal(removedAccountMembership.status, "archived");

  const servicesRemain = requireData(await service
    .from("project_services")
    .select("id", { count: "exact" })
    .eq("project_id", projectId), "check project service data");
  assert(servicesRemain.length > 0, "removing a member must preserve project service data");

  const removedAccess = await memberClient.rpc("get_project_access", { p_project_id: projectId });
  assert(removedAccess.error, "removed member must lose project access");

  console.log("project member integration passed");
} finally {
  if (projectId) await service.from("projects").delete().eq("id", projectId);
  const userIds = identities.map((identity) => identity.id).filter(Boolean);
  if (userIds.length) await service.from("accounts").delete().in("owner_id", userIds);
  for (const identity of identities) {
    if (identity.id) await service.auth.admin.deleteUser(identity.id);
  }
}
