create table if not exists public.rate_limit_policies (
  id uuid primary key default gen_random_uuid(),
  service text not null check (service in ('mcp', 'data', 'public_api')),
  dimension text not null check (dimension in ('ip', 'credential', 'project', 'account')),
  requests integer not null check (requests between 1 and 1000000),
  window_seconds integer not null check (window_seconds between 1 and 86400),
  enabled boolean not null default true,
  description text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (service, dimension)
);

create table if not exists public.rate_limit_buckets (
  policy_id uuid not null references public.rate_limit_policies(id) on delete cascade,
  dimension_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 1,
  expires_at timestamptz not null,
  primary key (policy_id, dimension_key, window_start)
);

create index if not exists rate_limit_buckets_expiry_idx on public.rate_limit_buckets (expires_at);

create table if not exists public.operational_checks (
  id bigint generated always as identity primary key,
  service text not null,
  status text not null check (status in ('healthy', 'degraded', 'down', 'unconfigured')),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);

create index if not exists operational_checks_service_time_idx on public.operational_checks (service, checked_at desc);

create table if not exists public.operational_service_states (
  service text primary key,
  status text not null check (status in ('healthy', 'degraded', 'down', 'unconfigured')),
  consecutive_failures integer not null default 0,
  last_checked_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  last_alerted_at timestamptz
);

create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'full' check (kind in ('database', 'storage', 'full')),
  status text not null check (status in ('running', 'completed', 'failed')),
  archive_name text,
  archive_sha256 text check (archive_sha256 is null or archive_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  database_bytes bigint check (database_bytes is null or database_bytes >= 0),
  object_count integer check (object_count is null or object_count >= 0),
  revision text,
  error_code text,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists backup_runs_started_idx on public.backup_runs (started_at desc);

create table if not exists public.restore_drills (
  id uuid primary key default gen_random_uuid(),
  backup_run_id uuid not null references public.backup_runs(id) on delete restrict,
  status text not null check (status in ('running', 'passed', 'failed')),
  checks jsonb not null default '{}'::jsonb,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists restore_drills_started_idx on public.restore_drills (started_at desc);

insert into public.rate_limit_policies (service, dimension, requests, window_seconds, description)
values
  ('mcp', 'ip', 120, 60, 'MCP requests from one network address'),
  ('mcp', 'credential', 60, 60, 'MCP requests for one project key'),
  ('mcp', 'project', 300, 60, 'MCP requests for one project'),
  ('mcp', 'account', 600, 60, 'MCP requests for one account'),
  ('data', 'ip', 180, 60, 'Protected data requests from one network address'),
  ('data', 'project', 120, 60, 'Protected data requests for one project'),
  ('data', 'account', 300, 60, 'Protected data requests for one account'),
  ('public_api', 'ip', 120, 60, 'Public API requests from one network address')
on conflict (service, dimension) do nothing;

alter table public.rate_limit_policies enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.operational_checks enable row level security;
alter table public.operational_service_states enable row level security;
alter table public.backup_runs enable row level security;
alter table public.restore_drills enable row level security;

create policy "Superadmin can read rate limit policies" on public.rate_limit_policies for select using (public.is_superadmin());
create policy "Superadmin can read operational checks" on public.operational_checks for select using (public.is_superadmin());
create policy "Superadmin can read operational states" on public.operational_service_states for select using (public.is_superadmin());
create policy "Superadmin can read backup runs" on public.backup_runs for select using (public.is_superadmin());
create policy "Superadmin can read restore drills" on public.restore_drills for select using (public.is_superadmin());

revoke insert, update, delete on public.rate_limit_policies, public.rate_limit_buckets,
  public.operational_checks, public.operational_service_states, public.backup_runs, public.restore_drills
from anon, authenticated;
revoke select on public.rate_limit_buckets from anon, authenticated;

create or replace function public.consume_rate_limit_dimensions(
  p_service text,
  p_dimensions jsonb,
  p_account_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_ip text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  policy record;
  raw_key text;
  safe_key text;
  bucket_start timestamptz;
  used integer;
  denied boolean := false;
  denied_dimension text;
  retry_after integer := 0;
  parsed_ip inet;
begin
  for policy in select * from public.rate_limit_policies where service = p_service and enabled order by dimension loop
    raw_key := p_dimensions ->> policy.dimension;
    if nullif(raw_key, '') is null then continue; end if;
    safe_key := case when policy.dimension = 'ip'
      then encode(extensions.digest(raw_key, 'sha256'), 'hex')
      else left(raw_key, 160)
    end;
    bucket_start := date_bin(make_interval(secs => policy.window_seconds), now(), '2000-01-01 00:00:00+00'::timestamptz);
    insert into public.rate_limit_buckets (policy_id, dimension_key, window_start, request_count, expires_at)
    values (policy.id, safe_key, bucket_start, 1, bucket_start + make_interval(secs => policy.window_seconds * 2))
    on conflict (policy_id, dimension_key, window_start) do update
      set request_count = public.rate_limit_buckets.request_count + 1
    returning request_count into used;
    if used > policy.requests and not denied then
      denied := true;
      denied_dimension := policy.dimension;
      retry_after := greatest(1, extract(epoch from bucket_start + make_interval(secs => policy.window_seconds) - now())::integer);
    end if;
  end loop;

  if random() < 0.01 then delete from public.rate_limit_buckets where expires_at < now(); end if;
  if p_ip ~ '^[0-9a-fA-F:.]+$' then parsed_ip := p_ip::inet; end if;
  if denied then
    insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata, ip)
    values (p_account_id, p_project_id, p_actor_id, 'security.rate_limit.blocked', 'rate_limit_policy', p_service,
      jsonb_build_object('service', p_service, 'dimension', denied_dimension, 'retry_after', retry_after), parsed_ip);
  end if;
  return jsonb_build_object('allowed', not denied, 'retry_after', retry_after, 'dimension', denied_dimension);
end;
$$;

create or replace function public.consume_mcp_rate_limit(
  p_credential_id uuid,
  p_ip text,
  p_gateway_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  context record;
begin
  select key.id as credential_id, key.created_by as actor_id, project.id as project_id, project.account_id
  into context
  from public.mcp_credentials key
  join public.projects project on project.id = key.project_id
  join public.spaces_services service on service.slug = 'spaces'
  join public.service_auth_secrets service_secret on service_secret.service_id = service.id
  where key.id = p_credential_id
    and key.revoked_at is null
    and service_secret.token_hash = extensions.digest(coalesce(p_gateway_secret, ''), 'sha256');
  if context.credential_id is null then raise exception 'Invalid gateway credential'; end if;
  return public.consume_rate_limit_dimensions('mcp', jsonb_build_object(
    'ip', coalesce(p_ip, ''),
    'credential', context.credential_id::text,
    'project', context.project_id::text,
    'account', context.account_id::text
  ), context.account_id, context.project_id, context.actor_id, p_ip);
end;
$$;

create or replace function public.consume_data_rate_limit(
  p_project_id uuid,
  p_actor_id uuid,
  p_ip text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id_value uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select project.account_id into account_id_value
  from public.projects project
  join public.project_memberships membership on membership.project_id = project.id
    and membership.user_id = p_actor_id and membership.status = 'active'
  where project.id = p_project_id and project.status = 'active';
  if account_id_value is null then raise exception 'Project access required'; end if;
  return public.consume_rate_limit_dimensions('data', jsonb_build_object(
    'ip', coalesce(p_ip, ''),
    'project', p_project_id::text,
    'account', account_id_value::text
  ), account_id_value, p_project_id, p_actor_id, p_ip);
end;
$$;

create or replace function public.admin_update_rate_limit_policy(
  p_policy_id uuid,
  p_requests integer,
  p_window_seconds integer,
  p_enabled boolean
)
returns public.rate_limit_policies
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.rate_limit_policies;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  if p_requests < 1 or p_requests > 1000000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Invalid rate limit';
  end if;
  update public.rate_limit_policies set requests = p_requests, window_seconds = p_window_seconds,
    enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
  where id = p_policy_id returning * into result;
  if result.id is null then raise exception 'Rate limit policy not found'; end if;
  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'security.rate_limit.updated', 'rate_limit_policy', result.id::text,
    jsonb_build_object('service', result.service, 'dimension', result.dimension, 'requests', result.requests,
      'window_seconds', result.window_seconds, 'enabled', result.enabled));
  return result;
end;
$$;

create or replace function public.operations_probe()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select jsonb_build_object('status', 'ok', 'checked_at', now()) $$;

create or replace function public.record_security_session_event(p_event text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id_value uuid;
  project_id_value uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_event not in ('sign_in', 'mfa_verified', 'sign_out') then raise exception 'Unsupported security event'; end if;
  select membership.account_id into account_id_value
  from public.account_memberships membership
  where membership.user_id = auth.uid() and membership.status = 'active'
  order by (membership.role = 'owner') desc, membership.created_at limit 1;
  select active_project_id into project_id_value from public.profiles where id = auth.uid();
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, project_id_value, auth.uid(), 'auth.' || p_event, 'session', auth.uid()::text,
    jsonb_build_object('aal', coalesce(auth.jwt()->>'aal', 'aal1'), 'provider', coalesce(auth.jwt()->'app_metadata'->>'provider', 'unknown')));
end;
$$;

revoke execute on function public.consume_rate_limit_dimensions(text, jsonb, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.consume_mcp_rate_limit(uuid, text, text) from public;
revoke execute on function public.consume_data_rate_limit(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_update_rate_limit_policy(uuid, integer, integer, boolean) from public, anon;
revoke execute on function public.operations_probe() from public, anon, authenticated;
revoke execute on function public.record_security_session_event(text) from public, anon;
grant execute on function public.consume_mcp_rate_limit(uuid, text, text) to anon, authenticated;
grant execute on function public.consume_data_rate_limit(uuid, uuid, text) to service_role;
grant execute on function public.admin_update_rate_limit_policy(uuid, integer, integer, boolean) to authenticated;
grant execute on function public.operations_probe() to service_role;
grant execute on function public.record_security_session_event(text) to authenticated;
