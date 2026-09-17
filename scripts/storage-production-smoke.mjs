import { encryptSecret } from "/app/server.js";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATA_PLANE_INTERNAL_SECRET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !DATA_PLANE_INTERNAL_SECRET) throw new Error("Data-plane environment is incomplete");

async function request(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || `Request failed (${response.status})`);
  return data;
}

const projects = await request("/rest/v1/projects?select=id,owner_id&system_key=eq.spaces-root&limit=1");
const project = projects[0];
if (!project?.id || !project?.owner_id) throw new Error("Spaces root project is unavailable");

const name = `SMOKE_${Date.now()}`;
const value = `storage-smoke-${Date.now()}`;
const encrypted = encryptSecret(value);
let secretId = null;

try {
  const stored = await request("/rest/v1/rpc/store_project_secret_ciphertext", {
    method: "POST",
    body: {
      p_project_id: project.id,
      p_secret_id: null,
      p_name: name,
      p_kind: "token",
      p_service_slug: "spaces",
      p_description: "Ephemeral production smoke",
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.authTag,
      p_actor_id: project.owner_id,
    },
  });
  secretId = stored.id;
  const resolvedResponse = await fetch("http://127.0.0.1:3000/internal/resolve", {
    method: "POST",
    headers: { "content-type": "application/json", "x-spaces-internal-secret": DATA_PLANE_INTERNAL_SECRET },
    body: JSON.stringify({ projectId: project.id, name, consumer: "production-smoke" }),
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
      body: { p_secret_id: secretId, p_status: "deleted", p_actor_id: project.owner_id },
    }).catch(() => {});
  }
}
