create table if not exists public.service_auth_secrets (
  service_id uuid primary key references public.spaces_services(id) on delete cascade,
  token_hash bytea not null,
  rotated_at timestamptz not null default now(),
  rotated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.service_tickets (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  service_id uuid not null references public.spaces_services(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists service_tickets_expiry_idx
  on public.service_tickets (expires_at)
  where used_at is null;

alter table public.service_auth_secrets enable row level security;
alter table public.service_tickets enable row level security;
revoke all on public.service_auth_secrets, public.service_tickets from anon, authenticated;

insert into public.service_auth_secrets (service_id, token_hash)
select id, decode('b48df1427e5f9bd205c88e8d6655b1a8c9bf64da2097b401c8aa345d59e69520', 'hex')
from public.spaces_services where slug = 'outline'
on conflict (service_id) do nothing;

insert into public.service_auth_secrets (service_id, token_hash)
select id, decode('c86a2a9cdf27b2ff3b42c520ee5450810d5e8ab1cfeaf792c0840ca2f82bd0ac', 'hex')
from public.spaces_services where slug = 'openseo'
on conflict (service_id) do nothing;

create or replace function public.create_service_ticket(p_project_id uuid, p_service_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text;
  target_service_id uuid;
  target_account_id uuid;
begin
  if auth.uid() is null or not public.is_project_member(p_project_id) then
    raise exception 'Project access required';
  end if;

  select ps.service_id, p.account_id into target_service_id, target_account_id
  from public.project_services ps
  join public.projects p on p.id = ps.project_id
  join public.accounts a on a.id = p.account_id
  join public.spaces_services s on s.id = ps.service_id
  where ps.project_id = p_project_id
    and s.slug = p_service_slug
    and s.status = 'active'
    and ps.status = 'ready'
    and p.status = 'active'
    and a.status = 'active';

  if target_service_id is null then raise exception 'The service is not ready for this project'; end if;

  delete from public.service_tickets
  where expires_at < now() - interval '1 hour' or used_at < now() - interval '1 hour';

  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.service_tickets (token_hash, service_id, project_id, user_id, expires_at)
  values (extensions.digest(raw_token, 'sha256'), target_service_id, p_project_id, auth.uid(), now() + interval '90 seconds');

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (target_account_id, p_project_id, auth.uid(), 'service.sso_ticket.created', 'service', target_service_id::text, jsonb_build_object('service_slug', p_service_slug));
  return raw_token;
end;
$$;

create or replace function public.exchange_service_ticket(
  p_ticket text,
  p_service_slug text,
  p_service_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ticket_record record;
  result jsonb;
begin
  select
    st.id,
    st.user_id,
    st.project_id,
    s.id as service_id,
    p.account_id,
    p.name as project_name,
    p.slug as project_slug,
    pr.email,
    pr.display_name,
    pr.avatar_url,
    pm.role
  into ticket_record
  from public.service_tickets st
  join public.spaces_services s on s.id = st.service_id
  join public.service_auth_secrets sas on sas.service_id = s.id
  join public.projects p on p.id = st.project_id and p.status = 'active'
  join public.accounts a on a.id = p.account_id and a.status = 'active'
  join public.profiles pr on pr.id = st.user_id
  join public.project_memberships pm on pm.project_id = p.id and pm.user_id = st.user_id and pm.status = 'active'
  where st.token_hash = extensions.digest(coalesce(p_ticket, ''), 'sha256')
    and s.slug = p_service_slug
    and sas.token_hash = extensions.digest(coalesce(p_service_secret, ''), 'sha256')
    and st.expires_at > now()
    and st.used_at is null
  for update of st;

  if ticket_record.id is null then raise exception 'Invalid or expired service ticket'; end if;
  update public.service_tickets set used_at = now() where id = ticket_record.id;

  result := jsonb_build_object(
    'user_id', ticket_record.user_id,
    'email', ticket_record.email,
    'display_name', ticket_record.display_name,
    'avatar_url', ticket_record.avatar_url,
    'account_id', ticket_record.account_id,
    'project_id', ticket_record.project_id,
    'project_name', ticket_record.project_name,
    'project_slug', ticket_record.project_slug,
    'role', ticket_record.role,
    'service_id', ticket_record.service_id
  );

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (ticket_record.account_id, ticket_record.project_id, ticket_record.user_id, 'service.sso_ticket.exchanged', 'service', ticket_record.service_id::text);
  return result;
end;
$$;

create or replace function public.admin_rotate_service_secret(p_service_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_secret text;
  target_service_id uuid;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  select id into target_service_id from public.spaces_services where slug = p_service_slug;
  if target_service_id is null then raise exception 'Service not found'; end if;
  raw_secret := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.service_auth_secrets (service_id, token_hash, rotated_at, rotated_by)
  values (target_service_id, extensions.digest(raw_secret, 'sha256'), now(), auth.uid())
  on conflict (service_id) do update set
    token_hash = excluded.token_hash,
    rotated_at = now(),
    rotated_by = auth.uid();
  return raw_secret;
end;
$$;

revoke execute on function public.create_service_ticket(uuid, text) from public, anon;
revoke execute on function public.exchange_service_ticket(text, text, text) from public;
revoke execute on function public.admin_rotate_service_secret(text) from public, anon;
grant execute on function public.create_service_ticket(uuid, text) to authenticated;
grant execute on function public.exchange_service_ticket(text, text, text) to anon, authenticated;
grant execute on function public.admin_rotate_service_secret(text) to authenticated;
