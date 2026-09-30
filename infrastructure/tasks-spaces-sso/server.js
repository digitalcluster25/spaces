// SPC-0017: Spaces ↔ Paca (tasks.spaces.community) bridge.
//
// Launch flow: Spaces "Открыть" → /spaces-sso#ticket → POST /spaces-sso/exchange
// (Spaces ticket → signed project context cookie) → Paca OIDC login against the
// Spaces Supabase OAuth Server → /spaces-sso/finish (project membership in Paca)
// → /projects/<paca project id>. Sign-in itself is done only by Paca's OIDC;
// the Supabase access token returned by the ticket exchange is never stored.
const http = require("http");
const crypto = require("crypto");
const { createPanelPage, readSignedContext } = require(`${process.env.SPACES_SHARED_DIR || "/spaces-shared"}/tenant-panel.js`);

const config = {
  port: Number(process.env.PORT || 3000),
  supabaseUrl: process.env.SPACES_SUPABASE_URL || process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  serviceSecret: process.env.SPACES_SERVICE_SECRET,
  pacaUrl: (process.env.PACA_INTERNAL_URL || "http://gateway:80").replace(/\/$/, ""),
  pacaApiKey: process.env.PACA_API_KEY,
  ssoSlug: process.env.PACA_SSO_SLUG || "spaces",
};

// Built-in Paca project roles: Admin, Editor, Viewer.
const ROLE_BY_SPACES_ROLE = { owner: "Admin", member: "Editor" };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isAuthorized(req, secret = config.serviceSecret) {
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!secret || provided.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

function sign(payload, secret = config.serviceSecret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function signProjectContext(claims, now = Date.now()) {
  return sign({
    projectId: claims.project_id,
    projectName: claims.project_name,
    projectSlug: claims.project_slug,
    accountName: claims.account_name,
    userId: claims.user_id,
    email: String(claims.email || "").toLowerCase(),
    role: claims.role,
    pacaProjectId: claims.external_tenant_id,
    services: claims.services,
    projects: claims.projects,
    exp: now + 8 * 60 * 60 * 1000,
  });
}

function safeInAppPath(value, fallback = "/") {
  try {
    const url = new URL(String(value || ""), "https://tasks.invalid");
    if (url.origin !== "https://tasks.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function loginPath(pacaProjectId) {
  const finish = `/spaces-sso/finish?project=${encodeURIComponent(pacaProjectId)}`;
  return `/api/v1/auth/sso/${encodeURIComponent(config.ssoSlug)}/login?redirect=${encodeURIComponent(finish)}`;
}

async function readJson(req, limit = 65536) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw httpError(413, "Request too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw httpError(400, "Invalid JSON");
  }
}

async function exchangeTicket(ticket, fetchImpl = fetch) {
  if (!config.supabaseUrl || !config.supabaseAnonKey || !config.serviceSecret) throw new Error("Spaces SSO env is not configured");
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/exchange_service_ticket`, {
    method: "POST",
    headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ p_ticket: ticket, p_service_slug: "tasks", p_service_secret: config.serviceSecret }),
  });
  if (!response.ok) throw httpError(401, "Invalid or expired Spaces ticket");
  const claims = await response.json();
  delete claims.access_token;
  return claims;
}

function createPaca(fetchImpl = fetch) {
  async function call(method, path, body) {
    if (!config.pacaApiKey) throw new Error("PACA_API_KEY is not configured");
    const response = await fetchImpl(`${config.pacaUrl}/api/v1${path}`, {
      method,
      headers: { "X-API-Key": config.pacaApiKey, "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success === false) {
      throw httpError(response.status === 404 ? 404 : 502, `Paca ${method} ${path} failed (${response.status})`);
    }
    return data?.data;
  }

  async function findUserByEmail(email) {
    const target = String(email || "").toLowerCase();
    for (let page = 1; page <= 50; page += 1) {
      const data = await call("GET", `/admin/users?page=${page}&page_size=100`);
      const items = data?.items || [];
      const match = items.find((user) => String(user.email || "").toLowerCase() === target);
      if (match) return match;
      if (items.length < 100) return null;
    }
    return null;
  }

  async function ensureMember(projectId, userId, spacesRole) {
    const roleName = ROLE_BY_SPACES_ROLE[spacesRole] || ROLE_BY_SPACES_ROLE.member;
    const roles = await call("GET", `/projects/${projectId}/roles`);
    const role = (roles?.items || roles || []).find((item) => (item.role_name || item.name) === roleName);
    if (!role) throw httpError(502, `Paca project role ${roleName} is missing`);
    const members = await call("GET", `/projects/${projectId}/members?page_size=100`);
    const existing = (members?.items || members || []).find((member) => member.user_id === userId);
    if (!existing) return call("POST", `/projects/${projectId}/members`, { user_id: userId, project_role_id: role.id });
    if (existing.project_role_id !== role.id) return call("PATCH", `/projects/${projectId}/members/${existing.id}`, { project_role_id: role.id });
    return existing;
  }

  async function removeHumanMembers(projectId) {
    const members = await call("GET", `/projects/${projectId}/members?page_size=100`);
    for (const member of members?.items || members || []) {
      if (member.member_type === "human") await call("DELETE", `/projects/${projectId}/members/${member.id}`);
    }
  }

  // The Paca project of a Spaces project is found only by the Spaces project id
  // stored in its settings, never by name or slug (see audit finding C1).
  async function findProjectBySpacesId(spacesProjectId) {
    for (let page = 1; page <= 50; page += 1) {
      const data = await call("GET", `/projects?page=${page}&page_size=100`);
      const items = data?.items || [];
      const match = items.find((item) => item.settings?.spaces_project_id === spacesProjectId);
      if (match) return match;
      if (items.length < 100) return null;
    }
    return null;
  }

  return { call, findUserByEmail, ensureMember, removeHumanMembers, findProjectBySpacesId };
}

async function provision(input, paca) {
  const project = input.project || {};
  if (!uuidPattern.test(String(project.id || "")) || !project.name) throw httpError(400, "Invalid Spaces project");
  const existing = await paca.findProjectBySpacesId(project.id);
  const externalId = existing?.id || null;
  const operation = String(input.operation || "");

  if (["provision", "resume", "restore"].includes(operation)) {
    if (externalId) return { externalTenantId: externalId };
    const created = await paca.call("POST", "/projects", {
      name: String(project.name).slice(0, 120),
      description: `Spaces project ${project.id}`,
      settings: { spaces_project_id: project.id },
    });
    return { externalTenantId: created.id };
  }
  if (!externalId) return { externalTenantId: null };
  if (["suspend", "archive"].includes(operation)) {
    await paca.removeHumanMembers(externalId);
    return { externalTenantId: externalId };
  }
  if (operation === "delete") {
    await paca.call("DELETE", `/projects/${externalId}`).catch((error) => {
      if (error.status !== 404) throw error;
    });
    return { externalTenantId: externalId };
  }
  throw httpError(400, "Unsupported provisioning operation");
}

function ticketPage() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces SSO</title></head>
<body>
<main style="min-height:100vh;display:grid;place-items:center;font:14px system-ui;color:#18181b">Открываем задачи...</main>
<script>
(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get("ticket");
  history.replaceState(null, "", "/spaces-sso");
  if (!ticket) return location.replace("https://spaces.community/account");
  const response = await fetch("/spaces-sso/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  if (!response.ok) return location.replace("https://spaces.community/account?service_error=tasks");
  const result = await response.json();
  location.replace(result.next);
})().catch(() => location.replace("https://spaces.community/account?service_error=tasks"));
</script>
</body>
</html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function createServer({ fetchImpl = fetch } = {}) {
  const paca = createPaca(fetchImpl);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "https://tasks.spaces.community");
      if (url.pathname === "/spaces-sso/health" && req.method === "GET") return send(res, 200, { status: "ok" });
      if (url.pathname === "/spaces-sso" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        });
        return res.end(ticketPage());
      }
      if (url.pathname === "/spaces-panel" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'",
        });
        return res.end(createPanelPage(readSignedContext(req, config.serviceSecret), "tasks"));
      }
      if (url.pathname === "/spaces-sso/exchange" && req.method === "POST") {
        const input = await readJson(req);
        const claims = await exchangeTicket(String(input.ticket || ""), fetchImpl);
        if (!claims.project_id || !uuidPattern.test(String(claims.external_tenant_id || ""))) throw httpError(409, "Tasks project is not provisioned");
        const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString();
        return send(res, 200, { next: loginPath(claims.external_tenant_id) }, {
          "Set-Cookie": `spaces_project_context=${signProjectContext(claims)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires}`,
        });
      }
      if (url.pathname === "/spaces-sso/finish" && req.method === "GET") {
        const context = readSignedContext(req, config.serviceSecret);
        const requested = url.searchParams.get("project");
        if (!context?.email || !context.pacaProjectId || requested !== context.pacaProjectId) {
          res.writeHead(302, { Location: "https://spaces.community/account?service_error=tasks", "Cache-Control": "no-store" });
          return res.end();
        }
        const user = await paca.findUserByEmail(context.email);
        if (!user) throw httpError(403, "Paca account was not created by SSO");
        await paca.ensureMember(context.pacaProjectId, user.id, context.role);
        res.writeHead(302, { Location: safeInAppPath(`/projects/${context.pacaProjectId}`), "Cache-Control": "no-store" });
        return res.end();
      }
      if (url.pathname === "/spaces-internal/provision" && req.method === "POST") {
        if (!isAuthorized(req)) return send(res, 401, { error: "Unauthorized" });
        return send(res, 200, await provision(await readJson(req), paca));
      }
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      const status = Number(error.status) || 500;
      console.error("tasks-spaces-sso", req.method, req.url?.split("?")[0], status, error.message);
      return send(res, status >= 400 && status < 600 ? status : 500, { error: status < 500 ? error.message : "Spaces SSO failed" });
    }
  });
}

if (require.main === module) {
  createServer().listen(config.port, () => console.log(`Spaces Tasks SSO listening on ${config.port}`));
}

module.exports = { config, createServer, createPaca, provision, safeInAppPath, loginPath, signProjectContext, isAuthorized };
