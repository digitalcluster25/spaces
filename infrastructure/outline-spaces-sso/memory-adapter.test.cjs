const assert = require("node:assert/strict");
const test = require("node:test");
const { activeTaskSection, checkpointText, completionTexts, decisionText, outlineProxyHeaders } = require("./memory-adapter.js");

test("formats a complete checkpoint without accepting an arbitrary project", () => {
  const text = checkpointText({
    taskId: "SPC-0001",
    status: "IMPLEMENTED",
    confirmed: "Tenant scope is fixed by the server.",
    changed: "Gateway added.",
    checks: "7 tests passed.",
    nextStep: "Deploy.",
    projectId: "attacker-project",
  });
  assert.match(text, /SPC-0001 — IMPLEMENTED/);
  assert.doesNotMatch(text, /attacker-project/);
});

test("rejects invalid task and ADR identifiers", () => {
  assert.throws(() => checkpointText({ taskId: "../../etc", status: "STARTED", confirmed: "x", nextStep: "y" }), /Invalid task ID/);
  assert.throws(() => decisionText({ id: "ADR-x", title: "x", status: "ACCEPTED", context: "x", decision: "x" }), /Invalid ADR ID/);
});

test("requires immutable production evidence for completion", () => {
  assert.throws(() => completionTexts({
    taskId: "SPC-0001",
    summary: "done",
    checks: "passed",
    commit: "main",
    productionRevision: "latest",
    nextStep: "next",
  }), /Invalid commit/);
  const result = completionTexts({
    taskId: "SPC-0001",
    summary: "done",
    checks: "passed",
    commit: "abcdef1",
    productionRevision: "abcdef1",
    nextStep: "SPC-0002",
  });
  assert.match(result.release, /Production revision: abcdef1/);
});

test("binds writes to the only active task section", () => {
  const queue = `# Queue

## SPC-0000 — completed

Статус: DONE

## SPC-0001 — gateway

Статус: ACTIVE

Checkpoint: ready

## SPC-0002 — next

Статус: READY`;
  assert.match(activeTaskSection(queue, "SPC-0001"), /gateway/);
  assert.equal(activeTaskSection(queue, "SPC-0000"), null);
  assert.equal(activeTaskSection(`${queue}\n\n## SPC-0003 — duplicate\n\nСтатус: ACTIVE`, "SPC-0001"), null);
  assert.match(activeTaskSection("## SPC-0001 — gateway\n\n**Статус:** ACTIVE\\n**Ответственный:** AI", "SPC-0001"), /gateway/);
});

test("preserves the public HTTPS origin for internal Outline API calls", () => {
  assert.deepEqual(outlineProxyHeaders("https://outline.spaces.community"), {
    host: "outline.spaces.community",
    "x-forwarded-proto": "https",
  });
});
