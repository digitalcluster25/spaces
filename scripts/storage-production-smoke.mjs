import { encryptSecret } from "/app/server.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATA_PLANE_INTERNAL_SECRET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATA_PLANE_INTERNAL_SECRET) throw new Error("Data-plane environment is incomplete");

async function request(path, { method = "GET", body, headers = {}, token = SUPABASE_SERVICE_ROLE_KEY } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || `Request failed (${response.status})`);
  return data;
}

const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const email = `storage-smoke-${suffix}@example.com`;
const password = `Spaces-${crypto.randomUUID()}-Aa1!`;
const name = `SMOKE_${Date.now()}`;
const value = `storage-smoke-${Date.now()}`;
const encrypted = encryptSecret(value);
let userId = null;
let accountId = null;
let projectId = null;
let secretId = null;

try {
  const createdUser = await request("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password, email_confirm: true, user_metadata: { name: "Storage smoke" } },
  });
  userId = createdUser.user?.id || createdUser.id;
  if (!userId) throw new Error("Temporary owner creation failed");

  const memberships = await request(`/rest/v1/account_memberships?select=account_id&user_id=eq.${userId}&role=eq.owner&limit=1`);
  accountId = memberships[0]?.account_id;
  if (!accountId) throw new Error("Temporary owner account is unavailable");

  const session = await request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });
  if (!session.access_token) throw new Error("Temporary owner sign-in failed");

  const project = await request("/rest/v1/rpc/create_account_project", {
    method: "POST",
    token: session.access_token,
    body: {
      p_account_id: accountId,
      project_name: `Storage smoke ${suffix}`,
      project_description: "Ephemeral production storage verification",
      project_logo_url: null,
      enabled_service_slugs: [],
    },
  });
  projectId = project.id;
  if (!projectId) throw new Error("Temporary project creation failed");

  const stored = await request("/rest/v1/rpc/store_project_secret_ciphertext", {
    method: "POST",
    body: {
      p_project_id: projectId,
      p_secret_id: null,
      p_name: name,
      p_kind: "token",
      p_service_slug: "spaces",
      p_description: "Ephemeral production smoke",
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.authTag,
      p_actor_id: userId,
    },
  });
  secretId = stored.id;
  const resolvedResponse = await fetch("http://127.0.0.1:3000/internal/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-spaces-internal-secret": DATA_PLANE_INTERNAL_SECRET },
    body: JSON.stringify({ projectId, name, consumer: "production-smoke" }),
  });
  const resolved = await resolvedResponse.json();
  if (!resolvedResponse.ok || resolved.value !== value || resolved.version !== 1) throw new Error("Encrypted secret resolution failed");
  const audits = await request(`/rest/v1/audit_events?select=metadata&target_id=eq.${secretId}&action=eq.storage.secret.accessed`);
  if (!audits.some((event) => event.metadata?.consumer === "production-smoke")) throw new Error("Secret access audit is missing");
  if (JSON.stringify(audits).includes(value)) throw new Error("Secret leaked into audit");
  console.log(JSON.stringify({ storage: "ok", encryption: "aes-256-gcm", audit: "ok", plaintextLeaked: false }));
} finally {
  if (secretId) {
    await request("/rest/v1/rpc/set_project_secret_status", {
      method: "POST",
      body: { p_secret_id: secretId, p_status: "deleted", p_actor_id: userId },
    }).catch(() => {});
  }
  if (projectId) await request(`/rest/v1/projects?id=eq.${projectId}`, { method: "DELETE" }).catch(() => {});
  if (accountId) await request(`/rest/v1/accounts?id=eq.${accountId}`, { method: "DELETE" }).catch(() => {});
  if (userId) await request(`/auth/v1/admin/users/${userId}`, { method: "DELETE" }).catch(() => {});
}
