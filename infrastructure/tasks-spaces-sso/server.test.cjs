const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

process.env.SPACES_SHARED_DIR = path.join(__dirname, "../shared");
process.env.SPACES_SERVICE_SECRET = "s".repeat(64);
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.PACA_API_KEY = "paca_test";
process.env.PACA_INTERNAL_URL = "http://paca.test";

const { createServer, provision, createPaca, safeInAppPath, signProjectContext } = require("./server.js");

const spacesProject = "f1857726-60e0-42ee-afd0-67b893f1ef6d";
const pacaProject = "97b9ffcc-116e-4625-9c0a-e82651d6dd0f";
const otherPaca = "11111111-2222-4333-8444-555555555555";

function fakePaca(state) {
  return async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method || "GET";
    state.calls.push(`${method} ${pathname}`);
    const ok = (data, status = 200) => ({ ok: true, status, json: async () => ({ success: true, data }) });
    if (pathname === "/rest/v1/rpc/exchange_service_ticket") {
      const body = JSON.parse(init.body);
      if (body.p_ticket !== "good" || body.p_service_slug !== "tasks") return { ok: false, status: 400, json: async () => ({}) };
      return { ok: true, json: async () => ({ project_id: spacesProject, project_name: "Spaces", user_id: "u1", email: "Owner@Example.com", role: "owner", external_tenant_id: pacaProject, access_token: "must-not-leak" }) };
    }
    assert.equal(init.headers["X-API-Key"], "paca_test");
    if (pathname === "/api/v1/projects" && method === "GET") return ok({ items: state.projects });
    if (pathname === "/api/v1/projects" && method === "POST") {
      const created = { id: otherPaca, ...JSON.parse(init.body) };
      state.projects.push(created);
      return ok(created, 201);
    }
    // Shapes as returned by Paca 0.18: plain arrays, role_name, member_type "human".
    if (pathname === `/api/v1/projects/${pacaProject}/roles`) return ok([{ id: "r-owner", role_name: "Admin" }, { id: "r-member", role_name: "Editor" }, { id: "r-viewer", role_name: "Viewer" }]);
    if (pathname === `/api/v1/projects/${pacaProject}/members` && method === "GET") return ok(state.members);
    if (pathname === `/api/v1/projects/${pacaProject}/members` && method === "POST") {
      state.members.push({ id: "m1", ...JSON.parse(init.body), member_type: "human" });
      return ok(state.members.at(-1), 201);
    }
    if (pathname.startsWith(`/api/v1/projects/${pacaProject}/members/`) && method === "DELETE") return ok({});
    if (pathname === `/api/v1/projects/${pacaProject}` && method === "DELETE") return ok({});
    if (pathname === "/api/v1/admin/users") {
      assert.equal(searchParams.get("page_size"), "100");
      return ok({ items: [{ id: "paca-user", email: "owner@example.com" }] });
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  };
}

function newState() {
  return { calls: [], members: [], projects: [{ id: pacaProject, name: "Spaces", settings: { spaces_project_id: spacesProject } }, { id: "x", name: "Commercial Projects", settings: {} }] };
}

async function withServer(state, run) {
  const server = createServer({ fetchImpl: fakePaca(state) });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

test("provision adopts the Paca project only by stored Spaces project id", async () => {
  const state = newState();
  const paca = createPaca(fakePaca(state));
  assert.deepEqual(await provision({ operation: "provision", project: { id: spacesProject, name: "Spaces" } }, paca), { externalTenantId: pacaProject });
  const other = "22222222-3333-4444-8555-666666666666";
  const created = await provision({ operation: "provision", project: { id: other, name: "Commercial Projects" } }, paca);
  assert.equal(created.externalTenantId, otherPaca);
  assert.equal(state.projects.at(-1).settings.spaces_project_id, other);
});

test("archive removes human members, delete removes the project, unknown project is a no-op", async () => {
  const state = newState();
  state.members.push({ id: "m9", member_type: "human" }, { id: "a1", member_type: "agent" });
  const paca = createPaca(fakePaca(state));
  await provision({ operation: "archive", project: { id: spacesProject, name: "Spaces" } }, paca);
  assert.ok(state.calls.includes(`DELETE /api/v1/projects/${pacaProject}/members/m9`));
  assert.ok(!state.calls.includes(`DELETE /api/v1/projects/${pacaProject}/members/a1`));
  await provision({ operation: "delete", project: { id: spacesProject, name: "Spaces" } }, paca);
  assert.ok(state.calls.includes(`DELETE /api/v1/projects/${pacaProject}`));
  assert.deepEqual(await provision({ operation: "delete", project: { id: "33333333-3333-4333-8333-333333333333", name: "X" } }, paca), { externalTenantId: null });
});

test("internal provisioning requires the service secret", async () => {
  await withServer(newState(), async (base) => {
    const denied = await fetch(`${base}/spaces-internal/provision`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${base}/spaces-internal/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(64)}` },
      body: JSON.stringify({ operation: "provision", project: { id: spacesProject, name: "Spaces" } }),
    });
    assert.deepEqual(await allowed.json(), { externalTenantId: pacaProject });
  });
});

test("ticket exchange sets a signed context and sends the browser to Paca OIDC without leaking the Supabase token", async () => {
  await withServer(newState(), async (base) => {
    const bad = await fetch(`${base}/spaces-sso/exchange`, { method: "POST", body: JSON.stringify({ ticket: "bad" }) });
    assert.equal(bad.status, 401);
    const response = await fetch(`${base}/spaces-sso/exchange`, { method: "POST", body: JSON.stringify({ ticket: "good" }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.next, `/api/v1/auth/sso/spaces/login?redirect=${encodeURIComponent(`/spaces-sso/finish?project=${pacaProject}`)}`);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /^spaces_project_context=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const payload = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url").toString());
    assert.equal(payload.email, "owner@example.com");
    assert.equal(payload.pacaProjectId, pacaProject);
    assert.ok(!JSON.stringify(payload).includes("must-not-leak"));
  });
});

test("finish adds the SSO user to the Paca project with the mapped role", async () => {
  const state = newState();
  await withServer(state, async (base) => {
    const cookie = `spaces_project_context=${signProjectContext({ project_id: spacesProject, user_id: "u1", email: "owner@example.com", role: "owner", external_tenant_id: pacaProject })}`;
    const noCookie = await fetch(`${base}/spaces-sso/finish?project=${pacaProject}`, { redirect: "manual" });
    assert.equal(noCookie.headers.get("location"), "https://spaces.community/account?service_error=tasks");
    const tampered = await fetch(`${base}/spaces-sso/finish?project=${otherPaca}`, { redirect: "manual", headers: { cookie } });
    assert.equal(tampered.headers.get("location"), "https://spaces.community/account?service_error=tasks");
    const response = await fetch(`${base}/spaces-sso/finish?project=${pacaProject}`, { redirect: "manual", headers: { cookie } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/projects/${pacaProject}`);
    assert.deepEqual(state.members.map((m) => [m.user_id, m.project_role_id]), [["paca-user", "r-owner"]]);
  });
});

test("safeInAppPath rejects off-site redirects", () => {
  assert.equal(safeInAppPath("/projects/1?x=1"), "/projects/1?x=1");
  assert.equal(safeInAppPath("//evil.com"), "/");
  assert.equal(safeInAppPath("/\\evil.com"), "/");
  assert.equal(safeInAppPath("https://evil.com/x"), "/");
});
