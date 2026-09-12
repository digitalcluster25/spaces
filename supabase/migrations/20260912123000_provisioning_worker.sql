create or replace function public.claim_provisioning_jobs(p_limit integer default 10)
returns table (
  job_id uuid,
  project_service_id uuid,
  operation text,
  attempts integer,
  service_slug text,
  project_id uuid,
  project_name text,
  project_slug text,
  owner_user_id uuid,
  owner_email text,
  owner_display_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  return query
  with candidates as (
    select pj.id
    from public.provisioning_jobs pj
    where (
      (pj.status in ('pending', 'failed') and pj.run_after <= now())
      or (pj.status = 'running' and pj.locked_at < now() - interval '5 minutes')
    )
      and pj.attempts < 8
    order by pj.run_after, pj.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update public.provisioning_jobs pj
    set status = 'running',
        attempts = pj.attempts + 1,
        locked_at = now(),
        last_error = null
    from candidates c
    where pj.id = c.id
    returning pj.*
  )
  select
    c.id,
    c.project_service_id,
    c.operation,
    c.attempts,
    s.slug,
    p.id,
    p.name,
    p.slug,
    p.owner_id,
    pr.email,
    pr.display_name
  from claimed c
  join public.project_services ps on ps.id = c.project_service_id
  join public.spaces_services s on s.id = ps.service_id
  join public.projects p on p.id = ps.project_id
  join public.profiles pr on pr.id = p.owner_id;
end;
$$;

create or replace function public.complete_provisioning_job(
  p_job_id uuid,
  p_success boolean,
  p_external_tenant_id text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_job public.provisioning_jobs;
  target_project_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select * into target_job
  from public.provisioning_jobs
  where id = p_job_id and status = 'running'
  for update;
  if target_job.id is null then
    raise exception 'Running provisioning job not found';
  end if;

  select project_id into target_project_id
  from public.project_services
  where id = target_job.project_service_id;

  if p_success then
    update public.provisioning_jobs
    set status = 'completed', completed_at = now(), locked_at = null, last_error = null
    where id = target_job.id;

    update public.project_services
    set status = case target_job.operation
          when 'suspend' then 'disabled'
          when 'archive' then 'archived'
          when 'delete' then 'archived'
          else 'ready'
        end,
        external_tenant_id = coalesce(p_external_tenant_id, external_tenant_id),
        last_error = null,
        retry_count = target_job.attempts - 1,
        last_checked_at = now(),
        updated_at = now()
    where id = target_job.project_service_id;

    if target_job.operation = 'delete'
      and not exists (
        select 1
        from public.provisioning_jobs pj
        join public.project_services ps on ps.id = pj.project_service_id
        where ps.project_id = target_project_id
          and pj.operation = 'delete'
          and pj.status <> 'completed'
      ) then
      delete from public.projects where id = target_project_id and status = 'deleting' and not is_system;
    end if;
  else
    update public.provisioning_jobs
    set status = 'failed',
        run_after = now() + make_interval(secs => least(3600, power(2, least(attempts, 10))::integer * 15)),
        locked_at = null,
        last_error = left(coalesce(nullif(p_error, ''), 'Provisioning failed'), 2000)
    where id = target_job.id;

    update public.project_services
    set status = 'error',
        last_error = left(coalesce(nullif(p_error, ''), 'Provisioning failed'), 2000),
        retry_count = target_job.attempts,
        last_checked_at = now(),
        updated_at = now()
    where id = target_job.project_service_id;
  end if;
end;
$$;

create or replace function public.enqueue_missing_provisioning_jobs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  with queued as (
    insert into public.provisioning_jobs (project_service_id, operation)
    select ps.id, 'provision'
    from public.project_services ps
    join public.spaces_services s on s.id = ps.service_id
    join public.projects p on p.id = ps.project_id
    where not s.is_core
      and p.status = 'active'
      and ps.status in ('ready', 'provisioning', 'error')
      and ps.external_tenant_id is null
      and not exists (
        select 1 from public.provisioning_jobs pj
        where pj.project_service_id = ps.id
          and pj.operation = 'provision'
          and pj.status in ('pending', 'running', 'failed')
      )
    returning id
  )
  select count(*)::integer into affected from queued;
  return affected;
end;
$$;

create or replace function public.admin_retry_provisioning_job(p_job_id uuid)
returns public.provisioning_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.provisioning_jobs;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  update public.provisioning_jobs
  set status = 'pending', attempts = 0, run_after = now(), locked_at = null, completed_at = null, last_error = null
  where id = p_job_id and status = 'failed'
  returning * into result;
  if result.id is null then raise exception 'Only a failed job can be retried'; end if;
  return result;
end;
$$;

revoke execute on function public.claim_provisioning_jobs(integer) from public, anon, authenticated;
revoke execute on function public.complete_provisioning_job(uuid, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.enqueue_missing_provisioning_jobs() from public, anon, authenticated;
grant execute on function public.claim_provisioning_jobs(integer) to service_role;
grant execute on function public.complete_provisioning_job(uuid, boolean, text, text) to service_role;
grant execute on function public.enqueue_missing_provisioning_jobs() to service_role;
grant execute on function public.purge_expired_projects() to service_role;

create or replace function public.authorize_service_access(p_project_id uuid, p_service_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'project_id', p.id,
    'project_name', p.name,
    'project_slug', p.slug,
    'role', pm.role
  )
  from public.projects p
  join public.project_memberships pm on pm.project_id = p.id
  join public.project_services ps on ps.project_id = p.id
  join public.spaces_services s on s.id = ps.service_id
  join public.accounts a on a.id = p.account_id
  where p.id = p_project_id
    and pm.user_id = auth.uid()
    and pm.status = 'active'
    and p.status = 'active'
    and a.status = 'active'
    and s.slug = p_service_slug
    and s.status = 'active'
    and ps.status = 'ready';
$$;

revoke execute on function public.authorize_service_access(uuid, text) from public, anon;
grant execute on function public.authorize_service_access(uuid, text) to authenticated;
