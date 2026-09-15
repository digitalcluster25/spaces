import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;

if (!url || !anonKey || !serviceKey) {
  throw new Error("Local Supabase integration environment is missing");
}

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `spaces-mcp-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
const gatewaySecret = `gateway-${suffix}`;
let userId = "";
const projectIds = [];

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

try {
  const created = requireData(await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  }), "create owner");
  userId = created.user.id;

  const owner = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  requireData(await owner.auth.signInWithPassword({ email, password }), "sign in owner");

  const membership = requireData(await service
    .from("account_memberships")
    .select("account_id")
    .eq("user_id", userId)
    .eq("role", "owner")
    .single(), "load owner account");
  requireData(await service.from("account_limit_overrides").upsert({
    account_id: membership.account_id,
    key: "active_projects",
    value: 3,
    reason: "MCP gateway integration test",
  }), "raise project limit for test");

  for (const name of ["MCP Primary", "MCP Other"]) {
    const project = requireData(await owner.rpc("create_account_project", {
      p_account_id: membership.account_id,
      project_name: `${name} ${suffix}`,
      project_description: "MCP gateway integration test",
      project_logo_url: null,
      enabled_service_slugs: ["openseo", "outline"],
    }), `create ${name}`);
    projectIds.push(project.id);
  }

  const spacesService = requireData(await service
    .from("spaces_services")
    .select("id")
    .eq("slug", "spaces")
    .single(), "load Spaces service");
  requireData(await service.from("service_auth_secrets").upsert({
    service_id: spacesService.id,
    token_hash: `\\x${createHash("sha256").update(gatewaySecret).digest("hex")}`,
  }), "set gateway secret");

  const invalidScopes = await owner.rpc("create_mcp_credential", {
    p_project_id: projectIds[0],
    p_name: "Invalid scopes",
    p_scopes: ["memory:write"],
    p_expires_at: null,
  });
  assert(invalidScopes.error, "memory:write must require memory:read");

  const credential = requireData(await owner.rpc("create_mcp_credential", {
    p_project_id: projectIds[0],
    p_name: "Integration agent",
    p_scopes: ["memory:read", "memory:write", "openseo:*"],
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }), "create MCP credential");
  assert.match(credential.token, /^spc_[a-f0-9]{64}$/);

  const exchanged = requireData(await service.rpc("exchange_mcp_gateway_credential", {
    p_token: credential.token,
    p_gateway_secret: gatewaySecret,
  }), "exchange MCP credential");
  assert.equal(exchanged.project_id, projectIds[0]);
  assert.notEqual(exchanged.project_id, projectIds[1]);
  assert.deepEqual(exchanged.scopes.sort(), ["memory:read", "memory:write", "openseo:*"].sort());

  requireData(await service.rpc("record_mcp_gateway_call", {
    p_credential_id: credential.id,
    p_tool: "memory.bootstrap",
    p_success: true,
    p_duration_ms: 12,
    p_error_code: null,
    p_gateway_secret: gatewaySecret,
  }), "record gateway audit event");
  const audit = requireData(await service
    .from("audit_events")
    .select("project_id, metadata")
    .eq("target_id", credential.id)
    .eq("action", "mcp.gateway.tool_called")
    .single(), "load gateway audit event");
  assert.equal(audit.project_id, projectIds[0]);
  assert.equal(audit.metadata.tool, "memory.bootstrap");
  assert.equal(JSON.stringify(audit.metadata).includes(credential.token), false);

  requireData(await owner.rpc("revoke_mcp_credential", {
    p_credential_id: credential.id,
  }), "revoke MCP credential");
  const revoked = await service.rpc("exchange_mcp_gateway_credential", {
    p_token: credential.token,
    p_gateway_secret: gatewaySecret,
  });
  assert(revoked.error, "revoked MCP credential must be rejected");

  const expiring = requireData(await owner.rpc("create_mcp_credential", {
    p_project_id: projectIds[0],
    p_name: "Expiring agent",
    p_scopes: ["memory:read"],
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }), "create expiring MCP credential");
  requireData(await service
    .from("mcp_credentials")
    .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
    .eq("id", expiring.id), "expire MCP credential");
  const expired = await service.rpc("exchange_mcp_gateway_credential", {
    p_token: expiring.token,
    p_gateway_secret: gatewaySecret,
  });
  assert(expired.error, "expired MCP credential must be rejected");

  console.log("MCP gateway integration passed");
} finally {
  for (const projectId of projectIds) {
    await service.from("projects").delete().eq("id", projectId);
  }
  if (userId) await service.auth.admin.deleteUser(userId);
}
