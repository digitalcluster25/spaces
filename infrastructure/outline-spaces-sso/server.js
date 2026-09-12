const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const teamSubdomain = process.env.SPACES_OUTLINE_TEAM_SUBDOMAIN || "spaces";
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

async function getSpacesUser(token) {
  if (!supabaseUrl || !supabaseAnonKey) throw new Error("Supabase env is not configured");
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
  });
  return response.ok ? response.json() : null;
}

async function findOrCreateOutlineUser(spacesUser) {
  const email = String(spacesUser.email || "").toLowerCase();
  if (!email) throw new Error("Spaces user has no email");

  const name = spacesUser.user_metadata?.name || spacesUser.user_metadata?.full_name || email.split("@")[0];
  const avatarUrl = spacesUser.user_metadata?.avatar_url || null;
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "https://outline.spaces.community");
    if (url.pathname !== "/" && url.pathname !== "/spaces-sso") return redirect(res, "/home", 404);

    const token = parseCookies(req.headers.cookie).spaces_access_token;
    if (!token) return redirect(res, "https://spaces.community/login?redirect_to=%2Faccount");

    const spacesUser = await getSpacesUser(token);
    if (!spacesUser) return redirect(res, "https://spaces.community/login?redirect_to=%2Faccount");

    const user = await findOrCreateOutlineUser(spacesUser);
    const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const accessToken = jwt.sign(
      { id: user.id, expiresAt: expires.toISOString(), type: "session", service: "spaces" },
      user.jwtSecret,
    );
    redirect(res, safeNext(url.searchParams.get("next")), 302, {
      "Set-Cookie": `accessToken=${accessToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expires.toUTCString()}`,
      "Cache-Control": "no-store",
    });
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Spaces SSO failed");
  }
});

server.listen(port, () => console.log(`Spaces Outline SSO listening on ${port}`));
