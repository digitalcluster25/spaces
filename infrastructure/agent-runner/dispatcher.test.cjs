const assert = require("node:assert/strict");
const test = require("node:test");

process.env.AGENT_HOOK_SECRET = "h".repeat(64);
const runner = require("./dispatcher.js");

test("BlockNote description becomes readable text with links", () => {
  const blocks = [
    { type: "paragraph", content: [{ type: "text", text: "Спецификация: " }, { type: "link", href: "https://outline.spaces.community/doc/spc-0018-avtozapusk-B3yhqvzNhk", content: [{ type: "text", text: "SPC-0018" }] }], children: [] },
    { type: "bulletListItem", content: [{ type: "text", text: "пункт" }], children: [{ type: "paragraph", content: [{ type: "text", text: "вложенный" }] }] },
  ];
  const text = runner.blocksToText(blocks);
  assert.match(text, /SPC-0018 \(https:\/\/outline\.spaces\.community\/doc\/spc-0018-avtozapusk-B3yhqvzNhk\)/);
  assert.match(text, /- пункт\n  вложенный/);
  assert.equal(runner.findSpecDocId(text), "B3yhqvzNhk");
  assert.equal(runner.findSpecDocId("no spec"), null);
});

test("agent result must start with an explicit RESULT line", () => {
  assert.deepEqual(runner.parseAgentResult("RESULT: DONE\nизменил файл"), { ok: true, summary: "изменил файл" });
  assert.equal(runner.parseAgentResult("RESULT: STUCK — нет спецификации").reason, "нет спецификации");
  assert.equal(runner.parseAgentResult("всё сделал").ok, false);
});

test("sensitive paths are flagged for the owner", () => {
  assert.deepEqual(runner.sensitiveFiles(["src/App.tsx", "supabase/migrations/x.sql", "package.json", "infrastructure/a.js"]), ["supabase/migrations/x.sql", "package.json", "infrastructure/a.js"]);
});

test("the agent is never allowed to push, reach the network or bypass permissions", () => {
  const allowed = runner.ALLOWED_TOOLS.join(" ");
  assert.doesNotMatch(allowed, /push|curl|wget|ssh|WebFetch|WebSearch|Bash\(\*\)|^Bash$/);
  assert.ok(runner.ALLOWED_TOOLS.every((tool) => tool !== "Bash"));
  assert.ok(runner.DISALLOWED_TOOLS.includes("Bash(git push:*)"));
  assert.ok(runner.BRANCH_PATTERN.test("spc-12"));
  assert.ok(!runner.BRANCH_PATTERN.test("main"));
});

test("prompt carries harness, spec and the restrictions", () => {
  const prompt = runner.buildPrompt({
    task: { task_number: 7, title: "Тест" }, branch: "spc-7", description: "описание", comments: ["- владелец: поправь"],
    spec: "текст спеки", harness: { sequence: 4, effective_config: { a: 1 } }, rework: true,
  });
  assert.match(prompt, /RESULT: DONE/);
  assert.match(prompt, /текст спеки/);
  assert.match(prompt, /"sequence": 4/);
  assert.match(prompt, /возвращена на доработку/);
});

test("hook requires the secret and a task id; duplicates are not queued twice", async () => {
  const seen = [];
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const queue = runner.createQueue({}, async (id) => { seen.push(id); await blocker; });
  const server = runner.createServer({ queue });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}/spaces-agents/hook`;
  const id = "ddefd5b3-dd46-40ef-8ca9-301ab562bbf1";
  try {
    assert.equal((await fetch(base, { method: "POST", body: JSON.stringify({ task_id: id }) })).status, 401);
    const headers = { "x-spaces-agent-secret": "h".repeat(64) };
    assert.equal((await fetch(base, { method: "POST", headers, body: "{}" })).status, 400);
    assert.deepEqual(await (await fetch(base, { method: "POST", headers, body: JSON.stringify({ task_id: id }) })).json(), { accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(await (await fetch(base, { method: "POST", headers, body: JSON.stringify({ task_id: id }) })).json(), { accepted: false });
    assert.deepEqual(seen, [id]);
  } finally {
    release();
    server.close();
  }
});

test("preview wait matches the pushed revision and reports failures", async () => {
  const sha = "a".repeat(40);
  const responses = [{ revision: "old", ok: true }, { revision: sha, ok: false, error: "build: boom" }];
  const fetchImpl = async () => ({ ok: true, json: async () => responses.shift() || { revision: sha, ok: true } });
  const sleep = async () => {};
  assert.deepEqual(await runner.waitForPreview(sha, { fetchImpl, sleep }), { ok: false, error: "build: boom" });
  assert.deepEqual(await runner.waitForPreview(sha, { fetchImpl, sleep }), { ok: true, error: "" });
  const never = await runner.waitForPreview(sha, { fetchImpl: async () => ({ ok: false }), sleep: async () => {}, minutes: 0 });
  assert.equal(never.ok, false);
  assert.equal(runner.STAGE_BRANCH, "stage");
  assert.ok(!runner.BRANCH_PATTERN.test(runner.STAGE_BRANCH));
});

test("old run directories are removed, recent and foreign ones are kept", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  for (const name of ["spc-1-100", "spc-2-200", "keep-me"]) fs.mkdirSync(path.join(root, name));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(root, "spc-1-100"), old, old);
  fs.utimesSync(path.join(root, "keep-me"), old, old);
  assert.equal(runner.cleanupOldRuns(root), 1);
  assert.deepEqual(fs.readdirSync(root).sort(), ["keep-me", "spc-2-200"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("acceptance: only the latest status change to «Принято» counts, by its actor", () => {
  const change = (actor, at, status) => ({ activity_type: "task.updated", actor_id: actor, created_at: at, content: { changes: [{ field: "status", new: status }] } });
  const comment = { activity_type: "comment", actor_id: "x", created_at: "2026-10-02T10:00:00Z", content: [] };
  assert.equal(runner.lastStatusChangeActor([change("owner", "2026-10-02T09:00:00Z", "Принято"), comment], "Принято"), "owner");
  assert.equal(runner.lastStatusChangeActor([change("owner", "2026-10-02T09:00:00Z", "Принято"), change("bot", "2026-10-02T09:30:00Z", "В процессе")], "Принято"), null);
  // order of the API response must not matter
  assert.equal(runner.lastStatusChangeActor([change("intruder", "2026-10-02T09:30:00Z", "Принято"), change("owner", "2026-10-02T09:00:00Z", "На утверждение")], "Принято"), "intruder");
  assert.equal(runner.lastStatusChangeActor([], "Принято"), null);
});

test("acceptance: release status and production check", async () => {
  const sha = "b".repeat(40);
  const statuses = [null, { revision: "old", ok: true }, { revision: sha, ok: false, stage: "migrations", error: "exit 1", backup: "x.spcbak" }];
  const release = await runner.waitForRelease(sha, { read: () => statuses.shift(), sleep: async () => {} });
  assert.deepEqual(release, { ok: false, stage: "migrations", error: "exit 1", backup: "x.spcbak" });
  assert.equal((await runner.waitForRelease(sha, { read: () => null, sleep: async () => {}, minutes: 0 })).stage, "timeout");

  const site = (bundleText) => async (url) => {
    if (url.includes("/assets/")) return { ok: true, status: 200, text: async () => bundleText };
    return { ok: true, status: 200, text: async () => '<script type="module" src="/assets/index-AbC.js"></script>' };
  };
  assert.deepEqual(await runner.checkProduction(sha, { fetchImpl: site(`x="${sha.slice(0, 12)}"`) }), { ok: true, error: "" });
  assert.equal((await runner.checkProduction(sha, { fetchImpl: site('x="000000000000"') })).ok, false);
  assert.equal((await runner.checkProduction(sha, { fetchImpl: async () => ({ ok: false, status: 502 }) })).error, "/ → HTTP 502");
  let calls = 0;
  const eventually = await runner.waitForProduction(sha, { check: async () => ({ ok: ++calls === 3, error: "x" }), sleep: async () => {} });
  assert.equal(eventually.ok, true);
});
