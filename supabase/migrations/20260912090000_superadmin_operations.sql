create table if not exists public.audit_meta_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  period_start timestamptz,
  period_end timestamptz,
  deleted_count bigint not null default 0,
  digest text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_meta_events enable row level security;
create policy "Superadmin can read audit meta events"
  on public.audit_meta_events for select using (public.is_superadmin());
revoke insert, update, delete on public.audit_meta_events from anon, authenticated;

create or replace function public.protect_spaces_core_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.slug = 'spaces' and (
    tg_op = 'DELETE'
    or new.slug is distinct from old.slug
    or new.status is distinct from 'active'
    or new.is_core is distinct from true
    or new.base_url is distinct from 'https://spaces.community'
  ) then
    raise exception 'The Spaces core service is immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists protect_spaces_core_service on public.spaces_services;
create trigger protect_spaces_core_service
  before update or delete on public.spaces_services
  for each row execute function public.protect_spaces_core_service();

create or replace function public.admin_save_service(
  p_service_id uuid,
  p_slug text,
  p_name text,
  p_subdomain text,
  p_description text,
  p_status text,
  p_base_url text,
  p_mcp_url text,
  p_auth_mode text,
  p_capabilities jsonb,
  p_sort_order integer
)
returns public.spaces_services
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.spaces_services;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if p_service_id is null then
    insert into public.spaces_services (
      slug, name, subdomain, description, status, base_url, mcp_url, auth_mode, capabilities, sort_order
    )
    values (
      lower(trim(p_slug)), trim(p_name), lower(trim(p_subdomain)), p_description, p_status,
      p_base_url, p_mcp_url, p_auth_mode, coalesce(p_capabilities, '{}'::jsonb), p_sort_order
    )
    returning * into result;
  else
    update public.spaces_services set
      slug = lower(trim(p_slug)),
      name = trim(p_name),
      subdomain = lower(trim(p_subdomain)),
      description = p_description,
      status = p_status,
      base_url = p_base_url,
      mcp_url = p_mcp_url,
      auth_mode = p_auth_mode,
      capabilities = coalesce(p_capabilities, '{}'::jsonb),
      sort_order = p_sort_order,
      updated_at = now()
    where id = p_service_id
    returning * into result;
  end if;
  if result.id is null then raise exception 'Service not found'; end if;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'service.registry.saved', 'service', result.id::text, jsonb_build_object('slug', result.slug, 'status', result.status));
  return result;
end;
$$;

create or replace function public.admin_set_account_status(p_account_id uuid, p_status text)
returns public.accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.accounts;
  protected_owner uuid;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  select owner_id into protected_owner from public.accounts where id = p_account_id;
  if exists (
    select 1 from public.profiles where id = protected_owner and is_superadmin
  ) and p_status <> 'active' then
    raise exception 'The superadmin account cannot be suspended or archived';
  end if;

  update public.accounts set status = p_status, updated_at = now() where id = p_account_id returning * into result;
  if result.id is null then raise exception 'Account not found'; end if;
  insert into public.audit_events (account_id, actor_id, action, target_type, target_id, metadata)
  values (result.id, auth.uid(), 'account.status.updated', 'account', result.id::text, jsonb_build_object('status', result.status));
  return result;
end;
$$;

create or replace function public.admin_set_subscription(
  p_account_id uuid,
  p_plan_code text,
  p_status text,
  p_seats integer
)
returns public.account_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan_id uuid;
  result public.account_subscriptions;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  select id into target_plan_id from public.plans where code = p_plan_code and is_active;
  if target_plan_id is null then raise exception 'Plan not found'; end if;

  insert into public.account_subscriptions (account_id, plan_id, status, seats)
  values (p_account_id, target_plan_id, p_status, greatest(p_seats, 1))
  on conflict (account_id) do update set
    plan_id = excluded.plan_id,
    status = excluded.status,
    seats = excluded.seats,
    updated_at = now()
  returning * into result;
  insert into public.audit_events (account_id, actor_id, action, target_type, target_id, metadata)
  values (p_account_id, auth.uid(), 'subscription.updated', 'subscription', p_account_id::text, jsonb_build_object('plan', p_plan_code, 'status', p_status, 'seats', p_seats));
  return result;
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
  update public.provisioning_jobs set status = 'pending', run_after = now(), locked_at = null, last_error = null
  where id = p_job_id and status = 'failed'
  returning * into result;
  if result.id is null then raise exception 'Only a failed job can be retried'; end if;
  return result;
end;
$$;

create or replace function public.admin_delete_audit_period(p_period_start timestamptz, p_period_end timestamptz)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  affected bigint;
  event_digest text;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if p_period_start is null or p_period_end is null or p_period_start >= p_period_end then
    raise exception 'A valid audit period is required';
  end if;

  select count(*), encode(extensions.digest(coalesce(string_agg(id::text || ':' || action || ':' || created_at::text, '|' order by id), ''), 'sha256'), 'hex')
  into affected, event_digest
  from public.audit_events
  where created_at >= p_period_start and created_at < p_period_end;

  insert into public.audit_meta_events (actor_id, action, period_start, period_end, deleted_count, digest)
  values (auth.uid(), 'audit.period.deleted', p_period_start, p_period_end, affected, event_digest);

  delete from public.audit_events where created_at >= p_period_start and created_at < p_period_end;
  return affected;
end;
$$;

create or replace function public.purge_expired_projects()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  with doomed as (
    select id from public.projects
    where status = 'archived' and not is_system and purge_at is not null and purge_at <= now()
    for update skip locked
  ), marked as (
    update public.projects p set status = 'deleting', updated_at = now()
    from doomed d where p.id = d.id returning p.id
  )
  select count(*)::integer into affected from marked;

  insert into public.provisioning_jobs (project_service_id, operation)
  select ps.id, 'delete'
  from public.project_services ps
  join public.projects p on p.id = ps.project_id
  where p.status = 'deleting'
    and not exists (
      select 1 from public.provisioning_jobs pj
      where pj.project_service_id = ps.id and pj.operation = 'delete' and pj.status in ('pending', 'running')
    );
  return affected;
end;
$$;

revoke execute on function public.protect_spaces_core_service() from public, anon, authenticated;
revoke execute on function public.admin_save_service(uuid, text, text, text, text, text, text, text, text, jsonb, integer) from public, anon;
revoke execute on function public.admin_set_account_status(uuid, text) from public, anon;
revoke execute on function public.admin_set_subscription(uuid, text, text, integer) from public, anon;
revoke execute on function public.admin_retry_provisioning_job(uuid) from public, anon;
revoke execute on function public.admin_delete_audit_period(timestamptz, timestamptz) from public, anon;
revoke execute on function public.purge_expired_projects() from public, anon, authenticated;

grant execute on function public.admin_save_service(uuid, text, text, text, text, text, text, text, text, jsonb, integer) to authenticated;
grant execute on function public.admin_set_account_status(uuid, text) to authenticated;
grant execute on function public.admin_set_subscription(uuid, text, text, integer) to authenticated;
grant execute on function public.admin_retry_provisioning_job(uuid) to authenticated;
grant execute on function public.admin_delete_audit_period(timestamptz, timestamptz) to authenticated;
