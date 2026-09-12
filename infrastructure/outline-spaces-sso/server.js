const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const teamSubdomain = process.env.SPACES_OUTLINE_TEAM_SUBDOMAIN || "spaces";
const serviceSecret = process.env.SPACES_SERVICE_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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

async function findOrCreateOutlineUser(claims) {
  const email = String(claims.email || "").toLowerCase();
  if (!email) throw new Error("Spaces user has no email");

  const name = claims.display_name || email.split("@")[0];
  const avatarUrl = claims.avatar_url || null;
  const client = await pool.connect();

  try {
    await client.query("begin");
    const teamResult = await client.query(
      'select id from teams where subdomain = $1 and "deletedAt" is null limit 1',
      [teamSubdomain],
    );
    if (!teamResult.rowCount) throw new Error(`Outline team ${teamSubdomain} not found`);

    const teamId = teamResult.rows[0].id;
    const existing = await client.query(
      'select id, "jwtSecret" from users where lower(email) = $1 and "teamId" = $2 and "deletedAt" is null limit 1',
      [email, teamId],
    );
    let user = existing.rows[0];
    let jwtSecret;

    try {
      jwtSecret = user && decryptOutlineValue(user.jwtSecret);
    } catch {
      jwtSecret = crypto.randomBytes(32).toString("hex");
    }

    if (!user) {
      user = (
        await client.query(
          `insert into users
            (id, email, name, "jwtSecret", "createdAt", "updatedAt", "teamId", "avatarUrl", "notificationSettings", role)
           values ($1, $2, $3, $4, now(), now(), $5, $6, '{}'::jsonb, 'member')
           returning id`,
          [crypto.randomUUID(), email, name, encryptOutlineValue(jwtSecret), teamId, avatarUrl],
        )
      ).rows[0];
    } else {
      await client.query(
        'update users set name = $1, "avatarUrl" = coalesce($2, "avatarUrl"), "jwtSecret" = $3, "lastActiveAt" = now(), "lastSignedInAt" = now(), "updatedAt" = now() where id = $4',
        [name, avatarUrl, encryptOutlineValue(jwtSecret), user.id],
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
    if (url.pathname !== "/spaces-sso/exchange" || req.method !== "POST") return redirect(res, "/home", 404);

    const input = await readJson(req);
    const claims = await exchangeTicket(String(input.ticket || ""));
    const user = await findOrCreateOutlineUser(claims);
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const accessToken = jwt.sign(
      { id: user.id, expiresAt: expires.toISOString(), type: "session", service: "spaces", projectId: claims.project_id },
      user.jwtSecret,
    );
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `accessToken=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`,
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
