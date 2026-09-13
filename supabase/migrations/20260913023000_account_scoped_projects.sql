create or replace function public.create_account_project(
  p_account_id uuid,
  project_name text,
  project_description text default null,
  project_logo_url text default null,
  enabled_service_slugs text[] default '{}'
)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  project_limit bigint;
  active_count bigint;
  project_slug text;
  created_project public.projects;
  service_record record;
  connection_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not public.is_account_owner(p_account_id) then raise exception 'Account owner access required'; end if;
  if nullif(trim(project_name), '') is null then raise exception 'Project name is required'; end if;

  perform 1 from public.accounts where id = p_account_id and status = 'active' for update;
  if not found then raise exception 'Account is unavailable'; end if;
  if exists (select 1 from public.projects where account_id = p_account_id and lower(name) = lower(trim(project_name))) then
    raise exception 'Project name must be unique';
  end if;

  project_limit := public.effective_account_limit(p_account_id, 'active_projects');
  select count(*) into active_count from public.projects where account_id = p_account_id and status = 'active' and not is_system;
  if not public.is_superadmin(current_user_id) and project_limit is not null and active_count >= project_limit then
    raise exception 'Active project limit reached';
  end if;

  project_slug := public.make_project_slug(project_name);
  if exists (select 1 from public.projects where account_id = p_account_id and slug = project_slug) then
    project_slug := left(project_slug, 70) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;

  insert into public.projects (account_id, owner_id, name, slug, description, logo_url)
  values (p_account_id, current_user_id, trim(project_name), project_slug, project_description, project_logo_url)
  returning * into created_project;

  insert into public.project_memberships (project_id, user_id, role)
  values (created_project.id, current_user_id, 'owner');

  for service_record in
    select * from public.spaces_services
    where status = 'active' and (is_core or slug = any(enabled_service_slugs))
  loop
    insert into public.project_services (project_id, service_id, status, external_tenant_name)
    values (created_project.id, service_record.id,
      case when service_record.is_core then 'ready' else 'provisioning' end, created_project.name)
    returning id into connection_id;
    if not service_record.is_core then
      insert into public.provisioning_jobs (project_service_id, operation) values (connection_id, 'provision');
    end if;
  end loop;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (p_account_id, created_project.id, current_user_id, 'project.created', 'project', created_project.id::text);
  return created_project;
end;
$$;

revoke execute on function public.create_account_project(uuid, text, text, text, text[]) from public, anon;
grant execute on function public.create_account_project(uuid, text, text, text, text[]) to authenticated;
