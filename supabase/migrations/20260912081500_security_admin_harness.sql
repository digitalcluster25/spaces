create or replace function public.is_superadmin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = check_user_id
      and is_superadmin
      and lower(email) = 'digitalcluster25@gmail.com'
      and check_user_id = auth.uid()
      and coalesce(auth.jwt()->>'aal', '') = 'aal2'
  );
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
begin
  select ht.id, hv.id into default_template_id, default_version_id
  from public.harness_templates ht
  join public.harness_versions hv on hv.template_id = ht.id
  where ht.key = 'spaces-core' and hv.status = 'published'
  order by hv.version desc
  limit 1;

  if default_template_id is not null then
    insert into public.project_harness_settings (
      project_id, template_id, active_version_id, user_config, conflict_report, updated_by
    )
    values (new.id, default_template_id, default_version_id, '{}'::jsonb, '[]'::jsonb, new.owner_id)
    on conflict (project_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists initialize_project_harness_on_create on public.projects;
create trigger initialize_project_harness_on_create
  after insert on public.projects
  for each row execute function public.initialize_project_harness();

insert into public.project_harness_settings (
  project_id, template_id, active_version_id, user_config, conflict_report, updated_by
)
select p.id, ht.id, hv.id, '{}'::jsonb, '[]'::jsonb, p.owner_id
from public.projects p
join public.harness_templates ht on ht.key = 'spaces-core'
join lateral (
  select id
  from public.harness_versions
  where template_id = ht.id and status = 'published'
  order by version desc
  limit 1
) hv on true
on conflict (project_id) do nothing;

create or replace function public.update_harness_user_config(p_project_id uuid, p_user_config jsonb)
returns public.project_harness_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  protected_keys text[] := array['identity', 'priority', 'security', 'tooling', 'quality'];
  cleaned_config jsonb := coalesce(p_user_config, '{}'::jsonb);
  conflicts jsonb := '[]'::jsonb;
  protected_key text;
  result public.project_harness_settings;
begin
  if not public.is_project_owner(p_project_id) then
    raise exception 'Project owner access required';
  end if;
  if jsonb_typeof(cleaned_config) <> 'object' then
    raise exception 'Harness settings must be an object';
  end if;

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
  set user_config = cleaned_config,
      conflict_report = conflicts,
      updated_by = auth.uid(),
      updated_at = now()
  where project_id = p_project_id
  returning * into result;

  if result.project_id is null then raise exception 'Harness is not initialized'; end if;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  select p.account_id, p.id, auth.uid(), 'harness.user_config.updated', 'harness', result.active_version_id::text,
    jsonb_build_object('ignored_conflicts', jsonb_array_length(conflicts))
  from public.projects p where p.id = p_project_id;
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
  result public.project_harness_settings;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  update public.project_harness_settings
  set active_version_id = offered_version_id,
      offered_version_id = null,
      updated_by = auth.uid(),
      updated_at = now()
  where project_id = p_project_id and offered_version_id is not null
  returning * into result;
  if result.project_id is null then raise exception 'No Harness update is offered'; end if;
  return result;
end;
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
  result public.harness_versions;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if coalesce((p_test_report->>'passed')::boolean, false) is not true then
    raise exception 'Harness tests must pass before publishing';
  end if;

  select id into target_template_id from public.harness_templates where key = p_template_key;
  if target_template_id is null then raise exception 'Harness template not found'; end if;
  select coalesce(max(version), 0) + 1 into next_version from public.harness_versions where template_id = target_template_id;

  insert into public.harness_versions (
    template_id, version, admin_config, git_revision, status, test_report, created_by, published_at
  )
  values (
    target_template_id, next_version, p_admin_config, p_git_revision, 'published', p_test_report, auth.uid(), now()
  )
  returning * into result;

  update public.project_harness_settings phs
  set offered_version_id = result.id, updated_at = now()
  from public.projects p
  where p.id = phs.project_id and p.system_key is distinct from 'spaces-root';

  update public.project_harness_settings
  set active_version_id = result.id, offered_version_id = null, updated_by = auth.uid(), updated_at = now()
  where project_id = (select id from public.projects where system_key = 'spaces-root');

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'harness.version.published', 'harness_version', result.id::text, jsonb_build_object('version', next_version));
  return result;
end;
$$;

create or replace function public.admin_update_plan_limit(
  p_plan_code text,
  p_key text,
  p_value bigint,
  p_unit text,
  p_status text,
  p_description text
)
returns public.plan_limits
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan_id uuid;
  result public.plan_limits;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  select id into target_plan_id from public.plans where code = p_plan_code;
  if target_plan_id is null then raise exception 'Plan not found'; end if;

  insert into public.plan_limits (plan_id, key, value, unit, status, description)
  values (target_plan_id, p_key, p_value, p_unit, p_status, p_description)
  on conflict (plan_id, key) do update set
    value = excluded.value,
    unit = excluded.unit,
    status = excluded.status,
    description = excluded.description,
    updated_at = now()
  returning * into result;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'plan.limit.updated', 'plan_limit', p_plan_code || ':' || p_key, to_jsonb(result));
  return result;
end;
$$;

create or replace function public.admin_set_account_limit(
  p_account_id uuid,
  p_key text,
  p_value bigint,
  p_reason text
)
returns public.account_limit_overrides
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.account_limit_overrides;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  insert into public.account_limit_overrides (account_id, key, value, reason, updated_by)
  values (p_account_id, p_key, p_value, p_reason, auth.uid())
  on conflict (account_id, key) do update set
    value = excluded.value,
    reason = excluded.reason,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into result;
  return result;
end;
$$;

create policy "Superadmin can read all profiles"
  on public.profiles for select using (public.is_superadmin());
create policy "Superadmin can read all accounts"
  on public.accounts for select using (public.is_superadmin());
create policy "Superadmin can read all account memberships"
  on public.account_memberships for select using (public.is_superadmin());
create policy "Superadmin can read all projects"
  on public.projects for select using (public.is_superadmin());
create policy "Superadmin can read all project memberships"
  on public.project_memberships for select using (public.is_superadmin());
create policy "Superadmin can read all project services"
  on public.project_services for select using (public.is_superadmin());
create policy "Superadmin can read all subscriptions"
  on public.account_subscriptions for select using (public.is_superadmin());
create policy "Superadmin can read all overrides"
  on public.account_limit_overrides for select using (public.is_superadmin());
create policy "Superadmin can read all audit events"
  on public.audit_events for select using (public.is_superadmin());
create policy "Superadmin can read all provisioning jobs"
  on public.provisioning_jobs for select using (public.is_superadmin());

revoke execute on function public.initialize_project_harness() from public, anon, authenticated;
revoke execute on function public.update_harness_user_config(uuid, jsonb) from public, anon;
revoke execute on function public.accept_harness_version(uuid) from public, anon;
revoke execute on function public.publish_harness_version(text, jsonb, jsonb, text) from public, anon;
revoke execute on function public.admin_update_plan_limit(text, text, bigint, text, text, text) from public, anon;
revoke execute on function public.admin_set_account_limit(uuid, text, bigint, text) from public, anon;

grant execute on function public.update_harness_user_config(uuid, jsonb) to authenticated;
grant execute on function public.accept_harness_version(uuid) to authenticated;
grant execute on function public.publish_harness_version(text, jsonb, jsonb, text) to authenticated;
grant execute on function public.admin_update_plan_limit(text, text, bigint, text, text, text) to authenticated;
grant execute on function public.admin_set_account_limit(uuid, text, bigint, text) to authenticated;
