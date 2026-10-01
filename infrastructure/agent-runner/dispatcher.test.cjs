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
