const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { createPanelPage, readSignedContext } = require("/spaces-shared/tenant-panel.js");

const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const teamSubdomain = process.env.SPACES_OUTLINE_TEAM_SUBDOMAIN || "spaces";
const serviceSecret = process.env.SPACES_SERVICE_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function isAuthorized(req) {
  const provided = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!serviceSecret || provided.length !== serviceSecret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(serviceSecret));
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [];
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
      })
      .filter((entry) => entry.length === 2),
  );
}

function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/home";
  return value;
}

function signProjectContext(claims) {
  const payload = Buffer.from(JSON.stringify({
    projectId: claims.project_id,
    projectName: claims.project_name,
    projectSlug: claims.project_slug,
    accountName: claims.account_name,
    userId: claims.user_id,
    role: claims.role,
    services: claims.services,
    projects: claims.projects,
    exp: Date.now() + 8 * 60 * 60 * 1000,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", serviceSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function redirect(res, location, status = 302, extraHeaders = {}) {
  res.writeHead(status, { Location: location, ...extraHeaders });
  res.end();
}

function encryptOutlineValue(value) {
  const key = Buffer.from(process.env.SECRET_KEY, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
}

function decryptOutlineValue(value) {
  const encrypted = Buffer.from(value);
  const key = Buffer.from(process.env.SECRET_KEY, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, encrypted.subarray(0, 16));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString("utf8"));
}

async function exchangeTicket(ticket) {
  if (!supabaseUrl || !supabaseAnonKey || !serviceSecret) throw new Error("Spaces SSO env is not configured");
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exchange_service_ticket`, {
    method: "POST",
    headers: { apikey: supabaseAnonKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_ticket: ticket,
      p_service_slug: "outline",
      p_service_secret: serviceSecret,
    }),
  });
  if (!response.ok) throw new Error("Invalid or expired Spaces ticket");
  return response.json();
}

function projectSubdomain(projectSlug, projectId) {
  if (projectSlug === "commercial-projects") return teamSubdomain;
  const slug = String(projectSlug || "project").replace(/[^a-z0-9-]/g, "-").slice(0, 70);
  return `spaces-${slug}-${String(projectId).replace(/-/g, "").slice(0, 8)}`;
}

async function ensureOutlineTeam(client, project) {
  const subdomain = projectSubdomain(project.slug, project.id);
  const existing = await client.query(
    'select id from teams where subdomain = $1 limit 1',
    [subdomain],
  );
  if (existing.rowCount) {
    await client.query(
      'update teams set name = $1, "deletedAt" = null, "suspendedAt" = null, "updatedAt" = now(), "signupQueryParams" = coalesce("signupQueryParams", \'{}\'::jsonb) || $2::jsonb where id = $3',
      [project.name, JSON.stringify({ spaces_project_id: project.id }), existing.rows[0].id],
    );
    return existing.rows[0].id;
  }

  const teamId = crypto.randomUUID();
  await client.query(
    `insert into teams
      (id, name, "createdAt", "updatedAt", subdomain, sharing, "documentEmbeds", "guestSignin",
       "defaultUserRole", "memberCollectionCreate", "inviteRequired", "memberTeamCreate", "passkeysEnabled", "signupQueryParams")
     values ($1, $2, now(), now(), $3, true, true, false, 'member', true, false, true, false, $4::jsonb)`,
    [teamId, project.name, subdomain, JSON.stringify({ spaces_project_id: project.id })],
  );
  return teamId;
}

async function findOrCreateOutlineUser(claims, providedTeamId) {
  const email = String(claims.email || "").toLowerCase();
  if (!email) throw new Error("Spaces user has no email");

  const name = claims.display_name || email.split("@")[0];
  const avatarUrl = claims.avatar_url || null;
  const outlineRole = claims.role === "owner" ? "admin" : "member";
  const client = await pool.connect();

  try {
    await client.query("begin");
    const teamId = providedTeamId || await ensureOutlineTeam(client, {
      id: claims.project_id,
      name: claims.project_name,
      slug: claims.project_slug,
    });
    const existing = await client.query(
      'select id, "jwtSecret" from users where lower(email) = $1 and "teamId" = $2 and "deletedAt" is null limit 1',
      [email, teamId],
    );
    let user = existing.rows[0];
    let jwtSecret = crypto.randomBytes(32).toString("hex");
    if (user) {
      try {
        jwtSecret = decryptOutlineValue(user.jwtSecret);
      } catch {
        // Replace legacy or damaged secrets with a valid Outline session secret.
      }
    }

    if (!user) {
      user = (
        await client.query(
          `insert into users
            (id, email, name, "jwtSecret", "createdAt", "updatedAt", "teamId", "avatarUrl", "notificationSettings", role)
           values ($1, $2, $3, $4, now(), now(), $5, $6, '{}'::jsonb, $7)
           returning id`,
          [crypto.randomUUID(), email, name, encryptOutlineValue(jwtSecret), teamId, avatarUrl, outlineRole],
        )
      ).rows[0];
    } else {
      await client.query(
        'update users set name = $1, "avatarUrl" = coalesce($2, "avatarUrl"), "jwtSecret" = $3, role = $4, "lastActiveAt" = now(), "lastSignedInAt" = now(), "updatedAt" = now() where id = $5',
        [name, avatarUrl, encryptOutlineValue(jwtSecret), outlineRole, user.id],
      );
    }

    await client.query("commit");
    return { id: user.id, jwtSecret };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function provisionOutline(input) {
  const project = input.project || {};
  if (!/^[0-9a-f-]{36}$/i.test(String(project.id || "")) || !project.name || !project.slug) {
    throw new Error("Invalid Spaces project");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const subdomain = projectSubdomain(project.slug, project.id);
    const team = await client.query('select id from teams where subdomain = $1 limit 1', [subdomain]);
    let teamId = team.rows[0]?.id;

    if (["provision", "resume", "restore"].includes(input.operation)) {
      teamId = await ensureOutlineTeam(client, project);
    } else if (!teamId && !["suspend", "archive", "delete"].includes(input.operation)) {
      throw new Error("Outline tenant not found");
    } else if (!teamId) {
      // Destructive operations are idempotent when no external tenant exists.
    } else if (input.operation === "suspend") {
      await client.query('update teams set "suspendedAt" = now(), "updatedAt" = now() where id = $1', [teamId]);
    } else if (input.operation === "archive") {
      await client.query('update teams set "deletedAt" = now(), "updatedAt" = now() where id = $1', [teamId]);
    } else if (input.operation === "delete") {
      await client.query('delete from teams where id = $1', [teamId]);
    } else {
      throw new Error("Unsupported provisioning operation");
    }
    await client.query("commit");

    if (["provision", "resume", "restore"].includes(input.operation) && input.owner?.email) {
      await findOrCreateOutlineUser({
        email: input.owner.email,
        display_name: input.owner.displayName,
        avatar_url: null,
        role: "owner",
      }, teamId);
    }
    return { externalTenantId: teamId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function ticketPage() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces SSO</title></head>
<body>
<main style="min-height:100vh;display:grid;place-items:center;font:14px system-ui;color:#18181b">Открываем Outline...</main>
<script>
(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get("ticket");
  const next = params.get("next") || "/home";
  history.replaceState(null, "", "/spaces-sso");
  if (!ticket) return location.replace("https://spaces.community/account");
  const response = await fetch("/spaces-sso/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, next }),
  });
  if (!response.ok) return location.replace("https://spaces.community/account?service_error=outline");
  const result = await response.json();
  location.replace(result.next);
})().catch(() => location.replace("https://spaces.community/account?service_error=outline"));
</script>
</body>
</html>`;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new Error("Request too large");
  }
  return JSON.parse(body || "{}");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "https://outline.spaces.community");
    if (url.pathname === "/") {
      return parseCookies(req.headers.cookie).accessToken
        ? redirect(res, "/home")
        : redirect(res, "https://spaces.community/account");
    }
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
      return res.end(createPanelPage(readSignedContext(req, serviceSecret), "outline"));
    }
    if (url.pathname === "/spaces-internal/provision" && req.method === "POST") {
      if (!isAuthorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }
      const result = await provisionOutline(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname !== "/spaces-sso/exchange" || req.method !== "POST") return redirect(res, "/home", 404);

    const input = await readJson(req);
    const claims = await exchangeTicket(String(input.ticket || ""));
    const user = await findOrCreateOutlineUser(claims);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const accessToken = jwt.sign(
      { id: user.id, expiresAt: expires.toISOString(), type: "session", service: "spaces", projectId: claims.project_id },
      user.jwtSecret,
    );
    const projectContext = signProjectContext(claims);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": [
        `accessToken=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`,
        `spaces_project_context=${projectContext}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`,
      ],
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ next: safeNext(input.next) }));
  } catch (error) {
    console.error(error);
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Spaces SSO failed" }));
  }
});

server.listen(port, () => console.log(`Spaces Outline SSO listening on ${port}`));
