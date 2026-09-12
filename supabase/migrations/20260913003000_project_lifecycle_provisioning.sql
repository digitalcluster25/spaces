create or replace function public.archive_project(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.projects;
  retention_days bigint;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  if exists (select 1 from public.projects where id = p_project_id and is_system) then raise exception 'System project cannot be archived'; end if;

  select public.effective_account_limit(account_id, 'archive_retention_days') into retention_days
  from public.projects where id = p_project_id;
  retention_days := coalesce(retention_days, 10);

  update public.projects
  set status = 'archived',
      archived_at = now(),
      purge_at = now() + make_interval(days => retention_days::integer),
      updated_at = now()
  where id = p_project_id and status = 'active'
  returning * into result;
  if result.id is null then raise exception 'Only an active project can be archived'; end if;

  with archived_connections as (
    update public.project_services
    set status_before_archive = status,
        status = 'archived',
        updated_at = now()
    where project_id = p_project_id
      and status not in ('archived', 'disabled')
    returning id, service_id
  )
  insert into public.provisioning_jobs (project_service_id, operation)
  select connection.id, 'archive'
  from archived_connections connection
  join public.spaces_services service on service.id = connection.service_id
  where not service.is_core
    and not exists (
      select 1 from public.provisioning_jobs job
      where job.project_service_id = connection.id
        and job.operation = 'archive'
        and job.status in ('pending', 'running', 'failed')
    );

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (result.account_id, result.id, auth.uid(), 'project.archived', 'project', result.id::text, jsonb_build_object('purge_at', result.purge_at));
  return result;
end;
$$;

create or replace function public.restore_project(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.projects;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;

  update public.projects
  set status = 'active', archived_at = null, purge_at = null, updated_at = now()
  where id = p_project_id and status = 'archived' and purge_at > now()
  returning * into result;
  if result.id is null then raise exception 'Project cannot be restored'; end if;

  update public.provisioning_jobs job
  set status = 'completed',
      completed_at = now(),
      locked_at = null,
      last_error = 'Superseded by project restore'
  from public.project_services connection
  where connection.id = job.project_service_id
    and connection.project_id = p_project_id
    and job.operation = 'archive'
    and job.status in ('pending', 'failed');

  update public.project_services connection
  set status = 'ready', status_before_archive = null, updated_at = now()
  from public.spaces_services service
  where connection.project_id = p_project_id
    and connection.service_id = service.id
    and service.is_core
    and connection.status = 'archived';

  with restored_connections as (
    update public.project_services connection
    set status = 'provisioning', status_before_archive = null, updated_at = now()
    from public.spaces_services service
    where connection.project_id = p_project_id
      and connection.service_id = service.id
      and not service.is_core
      and connection.status = 'archived'
    returning connection.id, connection.external_tenant_id
  )
  insert into public.provisioning_jobs (project_service_id, operation)
  select id, case when external_tenant_id is null then 'provision' else 'restore' end
  from restored_connections;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (result.account_id, result.id, auth.uid(), 'project.restored', 'project', result.id::text);
  return result;
end;
$$;
