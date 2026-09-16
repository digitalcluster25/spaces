create table if not exists public.project_harness_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  admin_version_id uuid not null references public.harness_versions(id) on delete restrict,
  user_config jsonb not null default '{}'::jsonb,
  effective_config jsonb not null,
  conflict_report jsonb not null default '[]'::jsonb,
  evaluation_report jsonb not null,
  action text not null default 'publish' check (action in ('initial', 'publish', 'admin_update', 'rollback', 'migration')),
  source_version_id uuid references public.project_harness_versions(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (project_id, sequence)
);

alter table public.project_harness_settings
  add column if not exists active_user_version_id uuid references public.project_harness_versions(id) on delete restrict;

create index if not exists project_harness_versions_project_created_idx
  on public.project_harness_versions (project_id, created_at desc);

alter table public.project_harness_versions enable row level security;

create policy "Members can read project harness versions"
  on public.project_harness_versions for select
  using (public.is_project_member(project_id));

revoke insert, update, delete on public.project_harness_versions from anon, authenticated;

create or replace function public.compose_harness_preview(p_project_id uuid, p_user_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed_keys text[] := array[
    'system_context', 'objectives', 'domain_terms', 'acceptance_criteria',
    'accuracy_rules', 'trusted_sources', 'response_preferences', 'forbidden_actions',
    'tool_preferences', 'required_deliverables', 'memory_notes', 'example_outputs'
  ];
  protected_keys text[] := array[
    'schema_version', 'identity', 'instructions', 'priority', 'security',
    'tooling', 'quality', 'response', 'runtime', 'memory'
  ];
  cleaned jsonb := coalesce(p_user_config, '{}'::jsonb);
  conflicts jsonb := '[]'::jsonb;
  admin_config jsonb;
  effective_config jsonb;
  evaluation jsonb;
  entry record;
begin
  if jsonb_typeof(cleaned) <> 'object' then raise exception 'Harness settings must be an object'; end if;
  if octet_length(cleaned::text) > 250000 then raise exception 'Harness settings are too large'; end if;

  select version.admin_config into admin_config
  from public.project_harness_settings settings
  join public.harness_versions version on version.id = settings.active_version_id
  where settings.project_id = p_project_id;
  if admin_config is null then raise exception 'Harness is not initialized'; end if;

  for entry in select key, value from jsonb_each(cleaned) loop
    if entry.key = any(protected_keys) then
      cleaned := cleaned - entry.key;
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'field', entry.key,
        'reason', 'Настройка противоречит обязательному административному слою и не применена'
      ));
    elsif not entry.key = any(allowed_keys) then
      cleaned := cleaned - entry.key;
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'field', entry.key,
        'reason', 'Поле не входит в поддерживаемый пользовательский слой и не применено'
      ));
    elsif jsonb_typeof(entry.value) <> 'string' then
      cleaned := cleaned - entry.key;
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'field', entry.key,
        'reason', 'Значение должно быть текстом и не применено'
      ));
    elsif length(entry.value #>> '{}') > 20000 then
      raise exception 'Harness field % is too long', entry.key;
    end if;
  end loop;

  effective_config := admin_config || jsonb_build_object('project_preferences', cleaned);
  evaluation := public.validate_harness_config(effective_config);
  return jsonb_build_object(
    'admin_config', admin_config,
    'user_config', cleaned,
    'effective_config', effective_config,
    'conflict_report', conflicts,
    'evaluation_report', evaluation
  );
end;
$$;

create or replace function public.create_project_harness_version(
  p_project_id uuid,
  p_user_config jsonb,
  p_action text,
  p_source_version_id uuid,
  p_created_by uuid
)
returns public.project_harness_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.project_harness_settings;
  preview jsonb;
  next_sequence integer;
  result public.project_harness_versions;
begin
  if p_action not in ('initial', 'publish', 'admin_update', 'rollback', 'migration') then
    raise exception 'Unsupported Harness version action';
  end if;

  select * into settings
  from public.project_harness_settings
  where project_id = p_project_id
  for update;
  if settings.project_id is null then raise exception 'Harness is not initialized'; end if;

  preview := public.compose_harness_preview(p_project_id, p_user_config);
  if coalesce((preview#>>'{evaluation_report,passed}')::boolean, false) is not true then
    raise exception 'Harness validation failed';
  end if;

  select coalesce(max(sequence), 0) + 1 into next_sequence
  from public.project_harness_versions
  where project_id = p_project_id;

  insert into public.project_harness_versions (
    project_id, sequence, admin_version_id, user_config, effective_config,
    conflict_report, evaluation_report, action, source_version_id, created_by
  ) values (
    p_project_id, next_sequence, settings.active_version_id,
    preview->'user_config', preview->'effective_config', preview->'conflict_report',
    preview->'evaluation_report', p_action, p_source_version_id, p_created_by
  ) returning * into result;

  update public.project_harness_settings
  set user_config = result.user_config,
      conflict_report = result.conflict_report,
      active_user_version_id = result.id,
      updated_by = p_created_by,
      updated_at = now()
  where project_id = p_project_id;

  return result;
end;
$$;

insert into public.project_harness_versions (
  project_id, sequence, admin_version_id, user_config, effective_config,
  conflict_report, evaluation_report, action, created_by, created_at
)
select settings.project_id,
       1,
       settings.active_version_id,
       preview.value->'user_config',
       preview.value->'effective_config',
       preview.value->'conflict_report',
       preview.value->'evaluation_report',
       'migration',
       coalesce(settings.updated_by, project.owner_id),
       settings.updated_at
from public.project_harness_settings settings
join public.projects project on project.id = settings.project_id
cross join lateral (select public.compose_harness_preview(settings.project_id, settings.user_config) as value) preview
where not exists (
  select 1 from public.project_harness_versions version where version.project_id = settings.project_id
);

update public.project_harness_settings settings
set active_user_version_id = version.id,
    user_config = version.user_config,
    conflict_report = version.conflict_report
from public.project_harness_versions version
where version.project_id = settings.project_id
  and version.sequence = 1
  and settings.active_user_version_id is null;

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
  root_project_id uuid;
  root_settings public.project_harness_settings;
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

  select id into root_project_id from public.projects where system_key = 'spaces-root';
  if root_project_id is not null then
    select * into root_settings from public.project_harness_settings where project_id = root_project_id for update;
    update public.project_harness_settings
    set active_version_id = result.id, offered_version_id = null, updated_by = auth.uid(), updated_at = now()
    where project_id = root_project_id;
    perform public.create_project_harness_version(
      root_project_id, root_settings.user_config, 'admin_update', root_settings.active_user_version_id, auth.uid()
    );
  end if;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'harness.version.published', 'harness_version', result.id::text,
    jsonb_build_object('version', next_version, 'git_revision', p_git_revision, 'checks', jsonb_array_length(server_report->'checks')));
  return result;
end;
$$;

create or replace function public.preview_harness_user_config(p_project_id uuid, p_user_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  project_system_key text;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select system_key into project_system_key from public.projects where id = p_project_id;
  if project_system_key = 'spaces-root' and not public.is_superadmin() then
    raise exception 'Superadmin AAL2 access required';
  end if;
  return public.compose_harness_preview(p_project_id, p_user_config);
end;
$$;

create or replace function public.publish_harness_user_config(p_project_id uuid, p_user_config jsonb)
returns public.project_harness_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  project_record public.projects;
  result public.project_harness_versions;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select * into project_record from public.projects where id = p_project_id;
  if project_record.system_key = 'spaces-root' and not public.is_superadmin() then
    raise exception 'Superadmin AAL2 access required';
  end if;

  result := public.create_project_harness_version(
    p_project_id, p_user_config, 'publish', null, auth.uid()
  );
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (
    project_record.account_id, p_project_id, auth.uid(), 'harness.user_version.published',
    'project_harness_version', result.id::text,
    jsonb_build_object('sequence', result.sequence, 'ignored_conflicts', jsonb_array_length(result.conflict_report))
  );
  return result;
end;
$$;

create or replace function public.rollback_harness_user_config(p_project_id uuid, p_version_id uuid)
returns public.project_harness_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  project_record public.projects;
  target public.project_harness_versions;
  result public.project_harness_versions;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select * into project_record from public.projects where id = p_project_id;
  if project_record.system_key = 'spaces-root' and not public.is_superadmin() then
    raise exception 'Superadmin AAL2 access required';
  end if;
  select * into target from public.project_harness_versions
  where id = p_version_id and project_id = p_project_id;
  if target.id is null then raise exception 'Harness version not found'; end if;

  result := public.create_project_harness_version(
    p_project_id, target.user_config, 'rollback', target.id, auth.uid()
  );
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (
    project_record.account_id, p_project_id, auth.uid(), 'harness.user_version.rolled_back',
    'project_harness_version', result.id::text,
    jsonb_build_object('sequence', result.sequence, 'source_version_id', target.id)
  );
  return result;
end;
$$;

create or replace function public.list_project_harness_versions(p_project_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', version.id,
    'sequence', version.sequence,
    'admin_version_id', version.admin_version_id,
    'admin_version', admin_version.version,
    'user_config', version.user_config,
    'effective_config', version.effective_config,
    'conflict_report', version.conflict_report,
    'evaluation_report', version.evaluation_report,
    'action', version.action,
    'source_version_id', version.source_version_id,
    'created_by', version.created_by,
    'author_name', profile.display_name,
    'author_email', profile.email,
    'created_at', version.created_at,
    'is_active', settings.active_user_version_id = version.id
  ) order by version.sequence desc), '[]'::jsonb) into result
  from public.project_harness_versions version
  join public.project_harness_settings settings on settings.project_id = version.project_id
  join public.harness_versions admin_version on admin_version.id = version.admin_version_id
  left join public.profiles profile on profile.id = version.created_by
  where version.project_id = p_project_id;
  return result;
end;
$$;

create or replace function public.accept_harness_version(p_project_id uuid)
returns public.project_harness_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.project_harness_settings;
  project_record public.projects;
  created_version public.project_harness_versions;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select * into project_record from public.projects where id = p_project_id;
  if project_record.system_key = 'spaces-root' and not public.is_superadmin() then
    raise exception 'Superadmin AAL2 access required';
  end if;

  select * into settings from public.project_harness_settings
  where project_id = p_project_id for update;
  if settings.offered_version_id is null then raise exception 'No Harness update is offered'; end if;

  update public.project_harness_settings
  set active_version_id = offered_version_id,
      offered_version_id = null,
      updated_by = auth.uid(),
      updated_at = now()
  where project_id = p_project_id;

  created_version := public.create_project_harness_version(
    p_project_id, settings.user_config, 'admin_update', settings.active_user_version_id, auth.uid()
  );

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (
    project_record.account_id, p_project_id, auth.uid(), 'harness.admin_version.accepted',
    'project_harness_version', created_version.id::text,
    jsonb_build_object('sequence', created_version.sequence, 'admin_version_id', created_version.admin_version_id)
  );

  select * into settings from public.project_harness_settings where project_id = p_project_id;
  return settings;
end;
$$;

create or replace function public.update_harness_user_config(p_project_id uuid, p_user_config jsonb)
returns public.project_harness_settings
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.publish_harness_user_config(p_project_id, p_user_config);
  return (select settings from public.project_harness_settings settings where settings.project_id = p_project_id);
end;
$$;

create or replace function public.initialize_project_harness()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_template_id uuid;
  default_version_id uuid;
  canonical_user_config jsonb := '{}'::jsonb;
begin
  select template.id, version.id into default_template_id, default_version_id
  from public.harness_templates template
  join public.harness_versions version on version.template_id = template.id
  where template.key = 'spaces-core' and version.status = 'published'
  order by version.version desc
  limit 1;

  select settings.user_config into canonical_user_config
  from public.project_harness_settings settings
  join public.projects project on project.id = settings.project_id
  where project.system_key = 'spaces-root';
  canonical_user_config := coalesce(canonical_user_config, '{}'::jsonb);

  if default_template_id is not null then
    insert into public.project_harness_settings (
      project_id, template_id, active_version_id, user_config, conflict_report, updated_by
    ) values (
      new.id, default_template_id, default_version_id, canonical_user_config, '[]'::jsonb, new.owner_id
    ) on conflict (project_id) do nothing;
    perform public.create_project_harness_version(new.id, canonical_user_config, 'initial', null, new.owner_id);
  end if;
  return new;
end;
$$;

revoke execute on function public.compose_harness_preview(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.create_project_harness_version(uuid, jsonb, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.preview_harness_user_config(uuid, jsonb) from public, anon;
revoke execute on function public.publish_harness_user_config(uuid, jsonb) from public, anon;
revoke execute on function public.rollback_harness_user_config(uuid, uuid) from public, anon;
revoke execute on function public.list_project_harness_versions(uuid) from public, anon;
revoke execute on function public.accept_harness_version(uuid) from public, anon;
revoke execute on function public.update_harness_user_config(uuid, jsonb) from public, anon;

grant execute on function public.preview_harness_user_config(uuid, jsonb) to authenticated;
grant execute on function public.publish_harness_user_config(uuid, jsonb) to authenticated;
grant execute on function public.rollback_harness_user_config(uuid, uuid) to authenticated;
grant execute on function public.list_project_harness_versions(uuid) to authenticated;
grant execute on function public.accept_harness_version(uuid) to authenticated;
grant execute on function public.update_harness_user_config(uuid, jsonb) to authenticated;
