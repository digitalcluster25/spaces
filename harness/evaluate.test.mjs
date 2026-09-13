import assert from "node:assert/strict";
import test from "node:test";
import defaults from "./defaults.json" with { type: "json" };
import { evaluateHarnessConfig, mergeHarnessConfig } from "./evaluate.mjs";

test("published defaults pass every Harness check", () => {
  const report = evaluateHarnessConfig(defaults);
  assert.equal(report.passed, true, report.checks.filter((item) => !item.passed).map((item) => item.message).join("\n"));
});

test("security rules and secrets cannot be published", () => {
  const unsafe = mergeHarnessConfig(defaults, { security: { tenant_isolation: false }, instructions: { developer_rules: "password=secret-value-that-must-never-be-saved-in-harness" } });
  const report = evaluateHarnessConfig(unsafe);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((item) => item.id === "security.tenant_isolation")?.passed, false);
  assert.equal(report.checks.find((item) => item.id === "no_secrets")?.passed, false);
});
