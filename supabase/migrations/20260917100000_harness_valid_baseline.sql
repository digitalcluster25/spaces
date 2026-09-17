do $migration$
declare
  target_template public.harness_templates;
  latest_version public.harness_versions;
  root_settings public.project_harness_settings;
  repaired_version public.harness_versions;
  superadmin_id uuid;
  root_project_id uuid;
  next_version integer;
  report jsonb;
  valid_config jsonb := $json$
  {
    "schema_version": 1,
    "identity": {
      "name": "Spaces Harness",
      "purpose": "Точная, безопасная и проверяемая работа агентов в пределах активного проекта"
    },
    "instructions": {
      "system_prompt": "Выполняй подтверждённую задачу пользователя строго в границах активного проекта. Не выдумывай факты, права, состояние систем или результаты проверок. Безопасность, изоляция данных и явные ограничения имеют высший приоритет.",
      "developer_rules": "Сначала прочитай доступный контекст и требования. Используй минимально необходимые права. Проверяй изменения до отчёта о готовности. Сообщай о противоречиях и неприменённых пользовательских настройках."
    },
    "priority": ["security", "tenant isolation", "permissions", "user intent", "accuracy", "verification", "speed"],
    "security": {
      "tenant_isolation": true,
      "least_privilege": true,
      "secret_redaction": true,
      "destructive_action_confirmation": true,
      "prompt_injection_defense": true,
      "external_content_untrusted": true,
      "data_minimization": true,
      "audit_required": true
    },
    "quality": {
      "require_acceptance_criteria": true,
      "require_tests": true,
      "require_production_check": true,
      "require_source_verification": true,
      "disclose_uncertainty": true,
      "task_completion_required": true
    },
    "tooling": {
      "verify_after_write": true,
      "retry_transient_failures": true,
      "record_audit_events": true,
      "browser_visual_qa": true,
      "protect_existing_changes": true
    },
    "response": {
      "language": "ru",
      "detail": "concise",
      "never_invent": true,
      "state_uncertainty": true,
      "user_preference_priority": true
    },
    "runtime": {
      "reasoning_effort": "high",
      "max_retries": 3,
      "context_policy": "Сначала актуальные требования проекта, затем релевантные документы и только потом история действий."
    },
    "memory": {
      "project_scoped": true,
      "vector_access": "least_privilege",
      "secret_storage_forbidden": true,
      "history_retention": "indefinite_user_controlled"
    }
  }
  $json$::jsonb;
begin
  select * into target_template from public.harness_templates where key = 'spaces-core';
  if target_template.id is null then return; end if;

  select * into latest_version
  from public.harness_versions
  where template_id = target_template.id and status = 'published'
  order by version desc
  limit 1;
  if latest_version.id is null then return; end if;

  report := public.validate_harness_config(latest_version.admin_config);
  if coalesce((report->>'passed')::boolean, false) then return; end if;

  select id into superadmin_id
  from public.profiles
  where is_superadmin and lower(email) = 'digitalcluster25@gmail.com';
  if superadmin_id is null then raise exception 'Spaces superadmin is required to repair Harness baseline'; end if;

  report := public.validate_harness_config(valid_config);
  if coalesce((report->>'passed')::boolean, false) is not true then
    raise exception 'Repaired Harness baseline failed validation';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.harness_versions
  where template_id = target_template.id;

  insert into public.harness_versions (
    template_id, version, admin_config, schema_version, git_revision,
    status, test_report, created_by, published_at
  ) values (
    target_template.id, next_version, valid_config, 1, '9ac92c21fbc7a10c27a660c4675fec20f43229f9',
    'published', report, superadmin_id, now()
  ) returning * into repaired_version;

  update public.project_harness_settings settings
  set offered_version_id = repaired_version.id, updated_at = now()
  from public.projects project
  where project.id = settings.project_id and project.system_key is distinct from 'spaces-root';

  select id into root_project_id from public.projects where system_key = 'spaces-root';
  if root_project_id is not null then
    select * into root_settings
    from public.project_harness_settings
    where project_id = root_project_id
    for update;

    update public.project_harness_settings
    set active_version_id = repaired_version.id,
        offered_version_id = null,
        updated_by = superadmin_id,
        updated_at = now()
    where project_id = root_project_id;

    perform public.create_project_harness_version(
      root_project_id,
      root_settings.user_config,
      'admin_update',
      root_settings.active_user_version_id,
      superadmin_id
    );
  end if;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (
    superadmin_id,
    'harness.version.baseline_repaired',
    'harness_version',
    repaired_version.id::text,
    jsonb_build_object('version', next_version, 'replaced_version_id', latest_version.id, 'checks', jsonb_array_length(report->'checks'))
  );
end;
$migration$;
