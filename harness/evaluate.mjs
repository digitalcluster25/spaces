const requiredTrue = [
  "security.tenant_isolation", "security.least_privilege", "security.secret_redaction",
  "security.destructive_action_confirmation", "security.prompt_injection_defense",
  "security.external_content_untrusted", "security.data_minimization", "security.audit_required",
  "quality.require_acceptance_criteria", "quality.require_tests", "quality.require_production_check",
  "quality.require_source_verification", "quality.disclose_uncertainty", "quality.task_completion_required",
  "tooling.verify_after_write", "tooling.retry_transient_failures", "tooling.record_audit_events",
  "tooling.browser_visual_qa", "tooling.protect_existing_changes", "response.never_invent",
  "response.state_uncertainty", "memory.project_scoped", "memory.secret_storage_forbidden"
];

const get = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);

export function mergeHarnessConfig(defaults, current) {
  if (!current || typeof current !== "object" || Array.isArray(current)) return structuredClone(defaults);
  const result = structuredClone(defaults);
  for (const [key, value] of Object.entries(current)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value) && typeof result[key] === "object"
      ? mergeHarnessConfig(result[key], value)
      : structuredClone(value);
  }
  return result;
}

export function evaluateHarnessConfig(config) {
  const checks = [];
  const check = (id, passed, message) => checks.push({ id, passed: Boolean(passed), message });
  check("schema", config && typeof config === "object" && !Array.isArray(config) && config.schema_version === 1, "Схема Harness должна иметь версию 1.");
  check("identity", typeof get(config, "identity.name") === "string" && get(config, "identity.name").trim().length > 0 && typeof get(config, "identity.purpose") === "string" && get(config, "identity.purpose").trim().length >= 20, "Заполните название и назначение Harness.");
  check("system_prompt", typeof get(config, "instructions.system_prompt") === "string" && get(config, "instructions.system_prompt").trim().length >= 80, "Системный промпт должен содержать не менее 80 символов.");
  check("developer_rules", typeof get(config, "instructions.developer_rules") === "string" && get(config, "instructions.developer_rules").trim().length >= 40, "Правила выполнения должны содержать не менее 40 символов.");
  check("priority", Array.isArray(config?.priority) && config.priority.length >= 5 && new Set(config.priority).size === config.priority.length && config.priority.every((item) => typeof item === "string" && item.trim()), "Задайте минимум пять уникальных приоритетов.");
  for (const path of requiredTrue) check(path, get(config, path) === true, `Обязательное правило ${path} нельзя отключить.`);
  check("runtime", ["low", "medium", "high", "xhigh"].includes(get(config, "runtime.reasoning_effort")) && Number.isInteger(get(config, "runtime.max_retries")) && get(config, "runtime.max_retries") >= 0 && get(config, "runtime.max_retries") <= 10, "Проверьте уровень рассуждения и число повторов.");
  const serialized = JSON.stringify(config ?? {});
  check("no_secrets", !/(sk-[a-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|password\s*[=:]|api[_ -]?key\s*[=:])/i.test(serialized), "В Harness нельзя хранить пароли, приватные ключи и API-ключи.");
  return { passed: checks.every((item) => item.passed), schema_version: 1, evaluated_at: new Date().toISOString(), checks };
}

export { requiredTrue };
