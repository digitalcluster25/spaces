import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SPACES_DATA_ENCRYPTION_KEY", "DATA_PLANE_INTERNAL_SECRET"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 200_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function encryptionKey(value = process.env.SPACES_DATA_ENCRYPTION_KEY) {
  if (!/^[a-f0-9]{64}$/i.test(value || "")) throw new Error("Invalid data encryption key");
  return Buffer.from(value, "hex");
}

export function encryptSecret(value, keyValue) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100_000) {
    throw Object.assign(new Error("Secret value must contain 1 to 100000 characters"), { status: 400 });
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(payload, keyValue) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyValue), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.auth_tag || payload.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function equalSecret(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function bearer(request) {
  return request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

async function requestSupabase(path, { method = "GET", token = process.env.SUPABASE_SERVICE_ROLE_KEY, body, query = "", headers = {} } = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}${path}${query}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.error || `Storage request failed (${response.status})`), { status: response.status });
  return data;
}

async function authenticatedUser(token) {
  if (!token) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const user = await requestSupabase("/auth/v1/user", { token });
  if (!user?.id) throw Object.assign(new Error("Authentication required"), { status: 401 });
  return user;
}

async function requireProjectOwner(token, projectId) {
  if (!uuidPattern.test(projectId || "")) throw Object.assign(new Error("Invalid project"), { status: 400 });
  const access = await requestSupabase("/rest/v1/rpc/get_project_access", {
    method: "POST",
    token,
    body: { p_project_id: projectId },
  });
  if (access?.role !== "owner") throw Object.assign(new Error("Project owner access required"), { status: 403 });
  return access;
}

function secretInput(body, rotating = false) {
  const name = String(body.name || "").trim().toUpperCase();
  const kind = String(body.kind || "api_key");
  const serviceSlug = body.serviceSlug ? String(body.serviceSlug).trim() : "";
  const description = body.description ? String(body.description).trim() : "";
  const value = String(body.value || "");
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) throw Object.assign(new Error("Use an uppercase name such as SERVICE_API_KEY"), { status: 400 });
  if (!["api_key", "token", "password", "credential", "custom"].includes(kind)) throw Object.assign(new Error("Unsupported secret kind"), { status: 400 });
  if (serviceSlug && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(serviceSlug)) throw Object.assign(new Error("Invalid service"), { status: 400 });
  if (description.length > 500) throw Object.assign(new Error("Description is too long"), { status: 400 });
  if (rotating && !uuidPattern.test(String(body.secretId || ""))) throw Object.assign(new Error("Invalid secret"), { status: 400 });
  return { name, kind, serviceSlug, description, value };
}

function publicSecret(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    kind: row.kind,
    service_slug: row.service_slug,
    description: row.description,
    status: row.status,
    version: row.version,
    rotated_at: row.rotated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listSecrets(request, response, url) {
  const token = bearer(request);
  await authenticatedUser(token);
  const projectId = url.searchParams.get("projectId") || "";
  await requireProjectOwner(token, projectId);
  const rows = await requestSupabase("/rest/v1/project_secret_metadata", {
    query: `?select=id,project_id,name,kind,service_slug,description,status,version,rotated_at,created_at,updated_at&project_id=eq.${encodeURIComponent(projectId)}&status=neq.deleted&order=updated_at.desc`,
  });
  return json(response, 200, { secrets: rows.map(publicSecret) });
}

async function saveSecret(request, response) {
  const token = bearer(request);
  const user = await authenticatedUser(token);
  const body = await readJson(request);
  const projectId = String(body.projectId || "");
  await requireProjectOwner(token, projectId);
  const input = secretInput(body, Boolean(body.secretId));
  const encrypted = encryptSecret(input.value);
  const stored = await requestSupabase("/rest/v1/rpc/store_project_secret_ciphertext", {
    method: "POST",
    body: {
      p_project_id: projectId,
      p_secret_id: body.secretId || null,
      p_name: input.name,
      p_kind: input.kind,
      p_service_slug: input.serviceSlug || null,
      p_description: input.description || null,
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.authTag,
      p_actor_id: user.id,
    },
  });
  return json(response, body.secretId ? 200 : 201, { secret: publicSecret(stored) });
}

async function changeSecretStatus(request, response, secretId) {
  const token = bearer(request);
  const user = await authenticatedUser(token);
  if (!uuidPattern.test(secretId)) throw Object.assign(new Error("Invalid secret"), { status: 400 });
  const body = await readJson(request);
  const status = request.method === "DELETE" ? "deleted" : String(body.status || "");
  if (!["active", "disabled", "deleted"].includes(status)) throw Object.assign(new Error("Unsupported status"), { status: 400 });
  const stored = await requestSupabase("/rest/v1/rpc/set_project_secret_status", {
    method: "POST",
    body: { p_secret_id: secretId, p_status: status, p_actor_id: user.id },
  });
  return json(response, 200, { secret: publicSecret(stored) });
}

async function resolveInternal(request, response) {
  if (!equalSecret(request.headers["x-spaces-internal-secret"], process.env.DATA_PLANE_INTERNAL_SECRET)) {
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
  const body = await readJson(request);
  const projectId = String(body.projectId || "");
  const name = String(body.name || "").trim().toUpperCase();
  if (!uuidPattern.test(projectId) || !/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) throw Object.assign(new Error("Invalid request"), { status: 400 });
  const rows = await requestSupabase("/rest/v1/project_secret_metadata", {
    query: `?select=id,version&project_id=eq.${encodeURIComponent(projectId)}&name=eq.${encodeURIComponent(name)}&status=eq.active&limit=1`,
  });
  const metadata = rows[0];
  if (!metadata) throw Object.assign(new Error("Secret unavailable"), { status: 404 });
  const versions = await requestSupabase("/rest/v1/project_secret_versions", {
    query: `?select=ciphertext,iv,auth_tag&secret_id=eq.${metadata.id}&version=eq.${metadata.version}&limit=1`,
  });
  if (!versions[0]) throw new Error("Secret version unavailable");
  await requestSupabase("/rest/v1/rpc/record_project_secret_access", {
    method: "POST",
    body: { p_secret_id: metadata.id, p_consumer: String(body.consumer || "service-adapter").slice(0, 120) },
  });
  return json(response, 200, { value: decryptSecret(versions[0]), version: metadata.version });
}

export function createDataPlaneServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://data-plane");
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/secrets") return await listSecrets(request, response, url);
      if (request.method === "POST" && url.pathname === "/secrets") return await saveSecret(request, response);
      const secretMatch = url.pathname.match(/^\/secrets\/([0-9a-f-]+)$/i);
      if (secretMatch && ["PATCH", "DELETE"].includes(request.method || "")) return await changeSecretStatus(request, response, secretMatch[1]);
      if (request.method === "POST" && url.pathname === "/internal/resolve") return await resolveInternal(request, response);
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("data-plane request failed", { path: request.url, message: error.message });
      const status = Number(error.status) || 500;
      return json(response, status, { error: status < 500 ? error.message : "Data service unavailable" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  encryptionKey();
  const port = Number(process.env.PORT || 3000);
  createDataPlaneServer().listen(port, "0.0.0.0", () => console.log(`Spaces data-plane listening on ${port}`));
}
