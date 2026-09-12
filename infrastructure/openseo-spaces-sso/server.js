const http = require("http");
const crypto = require("crypto");

const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SPACES_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const serviceSecret = process.env.SPACES_SERVICE_SECRET;

function signProjectContext(claims) {
  const payload = Buffer.from(JSON.stringify({
    projectId: claims.project_id,
    projectName: claims.project_name,
    projectSlug: claims.project_slug,
    userId: claims.user_id,
    role: claims.role,
    exp: Date.now() + 55 * 60 * 1000,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", serviceSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function ticketPage() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spaces SSO</title></head>
<body>
<main style="min-height:100vh;display:grid;place-items:center;font:14px system-ui;color:#18181b">Открываем OpenSEO...</main>
<script>
(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const ticket = params.get("ticket");
  const next = params.get("next") || "/";
  history.replaceState(null, "", "/spaces-sso");
  if (!ticket) return location.replace("https://spaces.community/account");
  const response = await fetch("/spaces-sso/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, next }),
  });
  if (!response.ok) return location.replace("https://spaces.community/account?service_error=openseo");
  const result = await response.json();
  location.replace(result.next);
})().catch(() => location.replace("https://spaces.community/account?service_error=openseo"));
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

async function exchangeTicket(ticket) {
  if (!supabaseUrl || !supabaseAnonKey || !serviceSecret) throw new Error("Spaces SSO env is not configured");
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exchange_service_ticket`, {
    method: "POST",
    headers: { apikey: supabaseAnonKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_ticket: ticket,
      p_service_slug: "openseo",
      p_service_secret: serviceSecret,
    }),
  });
  if (!response.ok) throw new Error("Invalid or expired Spaces ticket");
  return response.json();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "https://openseo.spaces.community");
    if (url.pathname === "/spaces-sso" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(ticketPage());
    }
    if (url.pathname !== "/spaces-sso/exchange" || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }

    const input = await readJson(req);
    const claims = await exchangeTicket(String(input.ticket || ""));
    if (!claims.access_token || !claims.project_id) throw new Error("Incomplete Spaces session");
    const projectContext = signProjectContext(claims);
    const cookies = [
      `spaces_access_token=${claims.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3300`,
      `spaces_project_context=${projectContext}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3300`,
    ];
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": cookies,
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ next: safeNext(input.next) }));
  } catch (error) {
    console.error(error);
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Spaces SSO failed" }));
  }
});

server.listen(port, () => console.log(`Spaces OpenSEO SSO listening on ${port}`));
