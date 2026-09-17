import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "./server.js";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.MCP_GATEWAY_SECRET = "gateway-secret";
process.env.OUTLINE_ADAPTER_SECRET = "outline-secret";
process.env.OUTLINE_ADAPTER_URL = "https://outline.test/memory";
process.env.OPENSEO_MCP_URL = "https://openseo.test/mcp";

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function withServer(fetchImpl, callback, options = {}) {
  const server = createGateway({ fetchImpl, rateLimit: options.rateLimit || 60, now: options.now || (() => 1_000) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function context(scopes = ["memory:read", "memory:write", "openseo:*"]) {
  return {
    credential_id: "credential-1",
    project_id: "project-fixed-by-server",
    project_name: "Spaces",
    scopes,
  };
}

function mockFetch(scopes, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    if (String(url).includes("exchange_mcp_gateway_credential")) return response(200, context(scopes));
    if (String(url).includes("record_mcp_gateway_call")) return response(200, null);
    if (String(url).includes("mcp_search_project_knowledge")) return response(200, [{ id: "knowledge-1", title: "Private" }]);
    if (String(url).includes("mcp_upsert_project_knowledge")) return response(200, { id: "knowledge-1", project_id: "project-fixed-by-server" });
    if (String(url).includes("outline.test")) return response(200, { projectId: body.projectId, operation: body.operation });
    if (String(url).includes("openseo.test")) return response(200, { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "rank" }] } });
    return response(404, { error: "not found" });
  };
}

async function rpc(base, message, token = "spc_test") {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
  });
}

test("requires a Spaces project credential", async () => {
  await withServer(mockFetch([]), async (base) => {
    const result = await rpc(base, { method: "tools/list" }, "invalid");
    assert.equal(result.status, 401);
  });
});

test("lists only tools allowed by credential scopes", async () => {
  await withServer(mockFetch(["memory:read"]), async (base) => {
    const result = await rpc(base, { method: "tools/list" });
    const data = await result.json();
    const names = data.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ["memory.bootstrap", "memory.search", "memory.get_active_task"]);
  });
});

test("uses the server credential project and ignores spoofed project input", async () => {
  const calls = [];
  await withServer(mockFetch(["memory:read"], calls), async (base) => {
    const result = await rpc(base, {
      method: "tools/call",
      params: { name: "memory.search", arguments: { query: "checkpoint", projectId: "attacker-project" } },
    });
    assert.equal(result.status, 200);
    const outline = calls.find((call) => call.url.includes("outline.test"));
    assert.equal(outline.body.projectId, "project-fixed-by-server");
    assert.equal("projectId" in outline.body.args, false);
  });
});

test("read-only credentials cannot write memory", async () => {
  const calls = [];
  await withServer(mockFetch(["memory:read"], calls), async (base) => {
    const result = await rpc(base, {
      method: "tools/call",
      params: {
        name: "memory.append_checkpoint",
        arguments: { taskId: "SPC-0001", status: "STARTED", confirmed: "ok", nextStep: "continue" },
      },
    });
    const data = await result.json();
    assert.equal(data.result.isError, true);
    assert.equal(calls.some((call) => call.url.includes("outline.test")), false);
  });
});

test("knowledge tools use the credential context and enforce read/write scopes", async () => {
  const calls = [];
  await withServer(mockFetch(["knowledge:read", "knowledge:write"], calls), async (base) => {
    const listed = await rpc(base, { method: "tools/list" });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ["knowledge.search", "knowledge.upsert"]);
    const saved = await rpc(base, { method: "tools/call", params: { name: "knowledge.upsert", arguments: { title: "Private", content: "Tenant content", projectId: "spoofed" } } });
    assert.equal(saved.status, 200);
    const upstream = calls.find((call) => call.url.includes("mcp_upsert_project_knowledge"));
    assert.equal(upstream.body.p_credential_id, "credential-1");
    assert.equal("projectId" in upstream.body, false);
  });

  await withServer(mockFetch(["knowledge:read"]), async (base) => {
    const result = await rpc(base, { method: "tools/call", params: { name: "knowledge.upsert", arguments: { title: "No", content: "Denied" } } });
    const data = await result.json();
    assert.equal(data.result.isError, true);
  });
});

test("validates and forwards activation only for writable memory", async () => {
  const calls = [];
  await withServer(mockFetch(["memory:read", "memory:write"], calls), async (base) => {
    const listed = await rpc(base, { method: "tools/list" });
    const names = (await listed.json()).result.tools.map((tool) => tool.name);
    assert(names.includes("memory.activate_task"));
    const result = await rpc(base, {
      method: "tools/call",
      params: {
        name: "memory.activate_task",
        arguments: {
          taskId: "SPC-0002",
          title: "External client E2E",
          goal: "Connect Codex.",
          requirements: "Use project scopes.",
          acceptance: "Bootstrap passes.",
          rollback: "Revoke the key.",
          firstCheckpoint: "STARTED.",
          projectId: "attacker-project",
        },
      },
    });
    assert.equal(result.status, 200);
    const outline = calls.find((call) => call.url.includes("outline.test"));
    assert.equal(outline.body.operation, "activate_task");
    assert.equal(outline.body.args.projectId, undefined);
  });
});

test("revoked credentials fail on every request", async () => {
  const fetchImpl = async (url) => String(url).includes("exchange_mcp_gateway_credential")
    ? response(400, { message: "Invalid or expired MCP credential" })
    : response(500, {});
  await withServer(fetchImpl, async (base) => {
    const result = await rpc(base, { method: "tools/list" });
    assert.equal(result.status, 401);
  });
});

test("rate limits a credential without logging its token", async () => {
  const calls = [];
  await withServer(mockFetch(["memory:read"], calls), async (base) => {
    assert.equal((await rpc(base, { method: "ping" })).status, 200);
    const limited = await rpc(base, { method: "ping" });
    assert.equal(limited.status, 429);
    const auditCalls = calls.filter((call) => call.url.includes("record_mcp_gateway_call"));
    assert.equal(JSON.stringify(auditCalls).includes("spc_test"), false);
  }, { rateLimit: 1 });
});

test("proxies OpenSEO through the same project key", async () => {
  const calls = [];
  await withServer(mockFetch(["openseo:*"], calls), async (base) => {
    const result = await rpc(base, { method: "tools/call", params: { name: "openseo.tools", arguments: {} } });
    const data = await result.json();
    assert.equal(data.result.content[0].text.includes("rank"), true);
    const upstream = calls.find((call) => call.url.includes("openseo.test"));
    assert.equal(upstream.body.method, "tools/list");
    assert.equal(upstream.headers.authorization, "Bearer spc_test");
    assert.equal(upstream.headers["mcp-protocol-version"], "2025-06-18");
    assert.equal(upstream.headers["x-forwarded-proto"], "https");
  });
});
