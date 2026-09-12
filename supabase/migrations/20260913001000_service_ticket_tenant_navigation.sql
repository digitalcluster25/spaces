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
    a.name as account_name,
    p.name as project_name,
    p.slug as project_slug,
    pr.email,
    pr.display_name,
    pr.avatar_url,
    pm.role,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'slug', linked.slug,
        'name', linked.name,
        'status', linked_ps.status
      ) order by linked.sort_order), '[]'::jsonb)
      from public.project_services linked_ps
      join public.spaces_services linked on linked.id = linked_ps.service_id
      where linked_ps.project_id = p.id
        and linked_ps.status not in ('disabled', 'archived')
        and linked.status = 'active'
        and not linked.is_core
    ) as services,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', visible_project.id,
        'name', visible_project.name,
        'service_status', visible_service.status
      ) order by visible_project.is_system desc, visible_project.created_at), '[]'::jsonb)
      from public.project_memberships visible_membership
      join public.projects visible_project on visible_project.id = visible_membership.project_id
      left join public.project_services visible_service
        on visible_service.project_id = visible_project.id
       and visible_service.service_id = s.id
      where visible_membership.user_id = st.user_id
        and visible_membership.status = 'active'
        and visible_project.account_id = p.account_id
        and visible_project.status = 'active'
    ) as projects
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
    'account_name', ticket_record.account_name,
    'project_id', ticket_record.project_id,
    'project_name', ticket_record.project_name,
    'project_slug', ticket_record.project_slug,
    'projects', ticket_record.projects,
    'role', ticket_record.role,
    'services', ticket_record.services,
    'service_id', ticket_record.service_id,
    'access_token', extensions.pgp_sym_decrypt(ticket_record.encrypted_access_token, p_ticket)
  );

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (ticket_record.account_id, ticket_record.project_id, ticket_record.user_id, 'service.sso_ticket.exchanged', 'service', ticket_record.service_id::text);
  return result;
end;
$$;
