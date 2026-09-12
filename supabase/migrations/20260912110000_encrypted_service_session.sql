alter table public.service_tickets
  add column if not exists encrypted_access_token bytea;

create or replace function public.create_service_ticket(p_project_id uuid, p_service_slug text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text;
  access_token text;
  authorization_header text;
  target_service_id uuid;
  target_account_id uuid;
begin
  if auth.uid() is null or not public.is_project_member(p_project_id) then
    raise exception 'Project access required';
  end if;

  authorization_header := coalesce((current_setting('request.headers', true)::jsonb)->>'authorization', '');
  if authorization_header not like 'Bearer %' then raise exception 'Bearer session is required'; end if;
  access_token := substring(authorization_header from 8);

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
  insert into public.service_tickets (
    token_hash, encrypted_access_token, service_id, project_id, user_id, expires_at
  )
  values (
    extensions.digest(raw_token, 'sha256'),
    extensions.pgp_sym_encrypt(access_token, raw_token, 'cipher-algo=aes256,compress-algo=0'),
    target_service_id,
    p_project_id,
    auth.uid(),
    now() + interval '90 seconds'
  );

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
    st.encrypted_access_token,
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
  update public.service_tickets
  set used_at = now(), encrypted_access_token = null
  where id = ticket_record.id;

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
    'service_id', ticket_record.service_id,
    'access_token', extensions.pgp_sym_decrypt(ticket_record.encrypted_access_token, p_ticket)
  );

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (ticket_record.account_id, ticket_record.project_id, ticket_record.user_id, 'service.sso_ticket.exchanged', 'service', ticket_record.service_id::text);
  return result;
end;
$$;
