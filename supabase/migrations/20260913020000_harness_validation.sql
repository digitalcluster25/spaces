create or replace function public.validate_harness_config(p_config jsonb)
returns jsonb
language sql
volatile
set search_path = public
as $$
  with checks(id, passed, message) as (
    values
      ('schema', jsonb_typeof(p_config) = 'object' and p_config->>'schema_version' = '1', 'Схема Harness должна иметь версию 1.'),
      ('identity', length(trim(coalesce(p_config#>>'{identity,name}', ''))) > 0 and length(trim(coalesce(p_config#>>'{identity,purpose}', ''))) >= 20, 'Заполните название и назначение Harness.'),
      ('system_prompt', length(trim(coalesce(p_config#>>'{instructions,system_prompt}', ''))) >= 80, 'Системный промпт должен содержать не менее 80 символов.'),
      ('developer_rules', length(trim(coalesce(p_config#>>'{instructions,developer_rules}', ''))) >= 40, 'Правила выполнения должны содержать не менее 40 символов.'),
      ('priority', case when jsonb_typeof(p_config->'priority') = 'array' then jsonb_array_length(p_config->'priority') >= 5 else false end, 'Задайте минимум пять приоритетов.'),
      ('security',
        p_config#>>'{security,tenant_isolation}' = 'true'
        and p_config#>>'{security,least_privilege}' = 'true'
        and p_config#>>'{security,secret_redaction}' = 'true'
        and p_config#>>'{security,destructive_action_confirmation}' = 'true'
        and p_config#>>'{security,prompt_injection_defense}' = 'true'
        and p_config#>>'{security,external_content_untrusted}' = 'true'
        and p_config#>>'{security,data_minimization}' = 'true'
        and p_config#>>'{security,audit_required}' = 'true',
        'Все обязательные правила безопасности должны быть включены.'),
      ('quality',
        p_config#>>'{quality,require_acceptance_criteria}' = 'true'
        and p_config#>>'{quality,require_tests}' = 'true'
        and p_config#>>'{quality,require_production_check}' = 'true'
        and p_config#>>'{quality,require_source_verification}' = 'true'
        and p_config#>>'{quality,disclose_uncertainty}' = 'true'
        and p_config#>>'{quality,task_completion_required}' = 'true',
        'Все обязательные правила качества должны быть включены.'),
      ('tooling',
        p_config#>>'{tooling,verify_after_write}' = 'true'
        and p_config#>>'{tooling,retry_transient_failures}' = 'true'
        and p_config#>>'{tooling,record_audit_events}' = 'true'
        and p_config#>>'{tooling,browser_visual_qa}' = 'true'
        and p_config#>>'{tooling,protect_existing_changes}' = 'true',
        'Все обязательные правила инструментов должны быть включены.'),
      ('truthfulness', p_config#>>'{response,never_invent}' = 'true' and p_config#>>'{response,state_uncertainty}' = 'true', 'Запрет выдумывать и обязанность сообщать неопределённость нельзя отключить.'),
      ('memory', p_config#>>'{memory,project_scoped}' = 'true' and p_config#>>'{memory,secret_storage_forbidden}' = 'true', 'Память должна быть изолирована по проекту и не хранить секреты.'),
      ('runtime',
        p_config#>>'{runtime,reasoning_effort}' in ('low', 'medium', 'high', 'xhigh')
        and case when coalesce(p_config#>>'{runtime,max_retries}', '') ~ '^[0-9]+$'
          then (p_config#>>'{runtime,max_retries}')::integer between 0 and 10 else false end,
        'Проверьте уровень рассуждения и число повторов.'),
      ('no_secrets', p_config::text !~* '(sk-[a-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|password[[:space:]]*[=:]|api[_ -]?key[[:space:]]*[=:])', 'В Harness нельзя хранить пароли, приватные ключи и API-ключи.')
  )
  select jsonb_build_object(
    'passed', bool_and(passed),
    'schema_version', 1,
    'evaluated_at', now(),
    'checks', jsonb_agg(jsonb_build_object('id', id, 'passed', passed, 'message', message) order by id)
  )
  from checks;
$$;

create or replace function public.publish_harness_version(
  p_template_key text,
  p_admin_config jsonb,
  p_test_report jsonb,
  p_git_revision text default null
)
returns public.harness_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  target_template_id uuid;
  next_version integer;
  server_report jsonb;
  result public.harness_versions;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if coalesce(p_git_revision, '') !~ '^[0-9a-f]{7,40}$' then raise exception 'Published Harness requires a Git revision'; end if;
  server_report := public.validate_harness_config(p_admin_config);
  if coalesce((server_report->>'passed')::boolean, false) is not true then
    raise exception 'Harness validation failed';
  end if;

  select id into target_template_id from public.harness_templates where key = p_template_key for update;
  if target_template_id is null then raise exception 'Harness template not found'; end if;
  select coalesce(max(version), 0) + 1 into next_version from public.harness_versions where template_id = target_template_id;

  insert into public.harness_versions (
    template_id, version, admin_config, schema_version, git_revision, status, test_report, created_by, published_at
  ) values (
    target_template_id, next_version, p_admin_config, 1, p_git_revision, 'published', server_report, auth.uid(), now()
  ) returning * into result;

  update public.project_harness_settings settings
  set offered_version_id = result.id, updated_at = now()
  from public.projects project
  where project.id = settings.project_id and project.system_key is distinct from 'spaces-root';

  update public.project_harness_settings
  set active_version_id = result.id, offered_version_id = null, updated_by = auth.uid(), updated_at = now()
  where project_id = (select id from public.projects where system_key = 'spaces-root');

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'harness.version.published', 'harness_version', result.id::text,
    jsonb_build_object('version', next_version, 'git_revision', p_git_revision, 'checks', jsonb_array_length(server_report->'checks')));
  return result;
end;
$$;

create or replace function public.update_harness_user_config(p_project_id uuid, p_user_config jsonb)
returns public.project_harness_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  protected_keys text[] := array['schema_version', 'identity', 'instructions', 'priority', 'security', 'tooling', 'quality', 'response', 'runtime', 'memory'];
  cleaned_config jsonb := coalesce(p_user_config, '{}'::jsonb);
  conflicts jsonb := '[]'::jsonb;
  protected_key text;
  result public.project_harness_settings;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  if jsonb_typeof(cleaned_config) <> 'object' then raise exception 'Harness settings must be an object'; end if;

  foreach protected_key in array protected_keys loop
    if cleaned_config ? protected_key then
      cleaned_config := cleaned_config - protected_key;
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'field', protected_key,
        'reason', 'Настройка противоречит обязательному административному слою и не применена'
      ));
    end if;
  end loop;

  update public.project_harness_settings
  set user_config = cleaned_config, conflict_report = conflicts, updated_by = auth.uid(), updated_at = now()
  where project_id = p_project_id
  returning * into result;
  if result.project_id is null then raise exception 'Harness is not initialized'; end if;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  select project.account_id, project.id, auth.uid(), 'harness.user_config.updated', 'harness', result.active_version_id::text,
    jsonb_build_object('ignored_conflicts', jsonb_array_length(conflicts))
  from public.projects project where project.id = p_project_id;
  return result;
end;
$$;

revoke execute on function public.validate_harness_config(jsonb) from public, anon;
revoke execute on function public.publish_harness_version(text, jsonb, jsonb, text) from public, anon;
revoke execute on function public.update_harness_user_config(uuid, jsonb) from public, anon;
grant execute on function public.validate_harness_config(jsonb) to authenticated;
grant execute on function public.publish_harness_version(text, jsonb, jsonb, text) to authenticated;
grant execute on function public.update_harness_user_config(uuid, jsonb) to authenticated;
