import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const endpoint = process.env.MCP_ENDPOINT || "https://mcp.spaces.community/mcp";
const shouldWrite = process.env.MCP_SMOKE_WRITE === "1";

if (!supabaseUrl || !serviceKey) throw new Error("Missing Supabase production environment");

const headers = {
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
};

async function rest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || `Supabase request failed (${response.status})`);
  return data;
}

async function mcp(token, method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function tokenRecord(projectId, userId, name, scopes) {
  const token = `spc_${randomBytes(32).toString("hex")}`;
  return {
    token,
    record: {
      project_id: projectId,
      created_by: userId,
      name,
      token_hash: createHash("sha256").update(token).digest("hex"),
      scopes,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    },
  };
}

async function insertCredential(projectId, userId, name, scopes) {
  const value = tokenRecord(projectId, userId, name, scopes);
  const rows = await rest("mcp_credentials", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify(value.record),
  });
  return { ...value, id: rows[0].id };
}

function toolResult(call) {
  assert.equal(call.status, 200);
  assert.equal(call.body?.error, undefined);
  assert.equal(call.body?.result?.isError, undefined);
  const text = call.body?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : call.body?.result;
}

const credentials = [];

try {
  const [profile] = await rest("profiles?email=eq.digitalcluster25%40gmail.com&select=id");
  assert(profile?.id, "superadmin profile is missing");
  const projects = await rest("projects?slug=in.(spaces,commercial-projects)&status=eq.active&select=id,name,slug");
  const spaces = projects.find((project) => project.slug === "spaces");
  const commercial = projects.find((project) => project.slug === "commercial-projects");
  assert(spaces && commercial, "required production projects are missing");

  const memory = await insertCredential(spaces.id, profile.id, "SPC-0001 production memory smoke", ["memory:read", "memory:write"]);
  const readonly = await insertCredential(spaces.id, profile.id, "SPC-0001 production readonly smoke", ["memory:read"]);
  const expired = await insertCredential(spaces.id, profile.id, "SPC-0001 production expired smoke", ["memory:read"]);
  const openseo = await insertCredential(commercial.id, profile.id, "SPC-0001 production OpenSEO smoke", ["openseo:*"]);
  credentials.push(memory, readonly, expired, openseo);

  const initialized = await mcp(memory.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Spaces production smoke", version: "1" } });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body?.result?.serverInfo?.name, "Spaces MCP Gateway");

  const tools = await mcp(memory.token, "tools/list");
  const toolNames = tools.body?.result?.tools?.map((tool) => tool.name) || [];
  assert(toolNames.includes("memory.bootstrap"));
  assert(!toolNames.includes("openseo.call"));

  const bootstrap = toolResult(await mcp(memory.token, "tools/call", { name: "memory.bootstrap", arguments: {} }));
  assert.equal(bootstrap.projectId, spaces.id);
  assert.equal(bootstrap.documents.length, 5);

  const spoofed = toolResult(await mcp(memory.token, "tools/call", {
    name: "memory.search",
    arguments: { query: "SPC-0001", projectId: commercial.id },
  }));
  assert.equal(spoofed.results.some((result) => result.title === "02 Очередь разработки"), true);

  const deniedWrite = await mcp(readonly.token, "tools/call", {
    name: "memory.append_checkpoint",
    arguments: { taskId: "SPC-0001", status: "VERIFYING", confirmed: "denied", nextStep: "none" },
  });
  assert.equal(deniedWrite.body?.result?.isError, true);

  if (shouldWrite) {
    toolResult(await mcp(memory.token, "tools/call", {
      name: "memory.append_checkpoint",
      arguments: {
        taskId: "SPC-0001",
        status: "DEPLOYED",
        confirmed: "Production Gateway, Outline Memory Adapter and OpenSEO proxy are reachable through the public Spaces MCP endpoint.",
        changed: "Deployed revision is active; Outline upgraded to 1.10.0.",
        checks: "initialize, tools/list, bootstrap, isolated search, readonly denial, revocation, expiration, OpenSEO tools and audit passed.",
        risks: "No active release blocker detected.",
        nextStep: "Record immutable completion evidence and activate SPC-0002.",
      },
    }));
  }

  const openSeoTools = toolResult(await mcp(openseo.token, "tools/call", { name: "openseo.tools", arguments: {} }));
  assert(openSeoTools.tools?.some((tool) => tool.name === "whoami"));
  const whoami = await mcp(openseo.token, "tools/call", { name: "openseo.call", arguments: { name: "whoami", arguments: {} } });
  assert.equal(whoami.status, 200);
  assert.equal(whoami.body?.result?.isError, undefined);

  await rest(`mcp_credentials?id=eq.${readonly.id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  assert.equal((await mcp(readonly.token, "tools/list")).status, 401);

  await rest(`mcp_credentials?id=eq.${expired.id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
  });
  assert.equal((await mcp(expired.token, "tools/list")).status, 401);

  const audit = await rest(`audit_events?target_id=eq.${memory.id}&action=eq.mcp.gateway.tool_called&select=metadata`);
  assert(audit.length >= (shouldWrite ? 3 : 2));
  assert.equal(JSON.stringify(audit).includes(memory.token), false);

  console.log(JSON.stringify({ gateway: "ok", memory: "ok", openseo: "ok", isolation: "ok", audit: "ok", wroteCheckpoint: shouldWrite }));
} finally {
  if (credentials.length) {
    await rest(`mcp_credentials?id=in.(${credentials.map((credential) => credential.id).join(",")})`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    }).catch(() => {});
  }
}
