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
  if not exists (select 1 from public.accounts where id = p_account_id) then raise exception 'Account not found'; end if;
  if not exists (select 1 from public.plan_limits where key = p_key) then raise exception 'Unknown limit'; end if;
  if p_value is not null and p_value < 0 then raise exception 'Limit cannot be negative'; end if;

  insert into public.account_limit_overrides (account_id, key, value, reason, updated_by)
  values (p_account_id, p_key, p_value, nullif(trim(p_reason), ''), auth.uid())
  on conflict (account_id, key) do update set
    value = excluded.value,
    reason = excluded.reason,
    updated_by = auth.uid(),
    updated_at = now()
  returning * into result;

  insert into public.audit_events (account_id, actor_id, action, target_type, target_id, metadata)
  values (p_account_id, auth.uid(), 'account.limit.updated', 'account_limit', p_account_id::text || ':' || p_key,
    jsonb_build_object('key', p_key, 'value', p_value, 'reason', nullif(trim(p_reason), '')));
  return result;
end;
$$;

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
  previous_status text;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if trim(p_slug) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'Invalid service slug'; end if;
  if trim(p_subdomain) !~ '^[a-z0-9.-]+$' then raise exception 'Invalid service subdomain'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Service name is required'; end if;
  if p_status not in ('planned', 'active', 'paused') then raise exception 'Invalid service status'; end if;
  if p_auth_mode not in ('spaces_ticket', 'spaces_session') then raise exception 'Invalid service auth mode'; end if;
  if p_base_url is not null and p_base_url !~ '^https://' then raise exception 'Service URL must use HTTPS'; end if;
  if p_mcp_url is not null and p_mcp_url !~ '^https://' then raise exception 'MCP URL must use HTTPS'; end if;
  if jsonb_typeof(coalesce(p_capabilities, '{}'::jsonb)) <> 'object' then raise exception 'Capabilities must be an object'; end if;

  if p_service_id is null then
    insert into public.spaces_services (
      slug, name, subdomain, description, status, base_url, mcp_url, auth_mode, capabilities, sort_order
    ) values (
      lower(trim(p_slug)), trim(p_name), lower(trim(p_subdomain)), p_description, p_status,
      p_base_url, p_mcp_url, p_auth_mode, coalesce(p_capabilities, '{}'::jsonb), p_sort_order
    ) returning * into result;
  else
    select status into previous_status from public.spaces_services where id = p_service_id for update;
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

  if result.status = 'active' and not result.is_core then
    insert into public.project_services (project_id, service_id, status, external_tenant_name)
    select project.id, result.id, 'provisioning', project.name
    from public.projects project
    where project.status = 'active'
    on conflict (project_id, service_id) do nothing;

    update public.project_services
    set status = 'provisioning', status_before_archive = null, last_error = null, updated_at = now()
    where service_id = result.id
      and status in ('disabled', 'suspended')
      and status_before_archive = 'service_paused';

    insert into public.provisioning_jobs (project_service_id, operation)
    select connection.id, case when connection.external_tenant_id is null then 'provision' else 'resume' end
    from public.project_services connection
    where connection.service_id = result.id
      and connection.status = 'provisioning'
      and not exists (
        select 1 from public.provisioning_jobs job
        where job.project_service_id = connection.id and job.status in ('pending', 'running')
      );
  elsif previous_status = 'active' and result.status in ('paused', 'planned') and not result.is_core then
    update public.project_services
    set status = 'suspended', status_before_archive = 'service_paused', updated_at = now()
    where service_id = result.id and status not in ('disabled', 'archived', 'suspended');

    insert into public.provisioning_jobs (project_service_id, operation)
    select connection.id, 'suspend'
    from public.project_services connection
    where connection.service_id = result.id
      and connection.status = 'suspended'
      and connection.external_tenant_id is not null
      and not exists (
        select 1 from public.provisioning_jobs job
        where job.project_service_id = connection.id and job.status in ('pending', 'running')
      );

    update public.project_services
    set status = 'disabled', updated_at = now()
    where service_id = result.id and status = 'suspended' and external_tenant_id is null;
  end if;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'service.registry.saved', 'service', result.id::text,
    jsonb_build_object('slug', result.slug, 'status', result.status, 'previous_status', previous_status));
  return result;
end;
$$;

revoke execute on function public.admin_set_account_limit(uuid, text, bigint, text) from public, anon;
revoke execute on function public.admin_save_service(uuid, text, text, text, text, text, text, text, text, jsonb, integer) from public, anon;
grant execute on function public.admin_set_account_limit(uuid, text, bigint, text) to authenticated;
grant execute on function public.admin_save_service(uuid, text, text, text, text, text, text, text, text, jsonb, integer) to authenticated;
