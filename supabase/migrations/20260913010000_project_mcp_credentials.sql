create or replace function public.create_mcp_credential(
  p_project_id uuid,
  p_name text,
  p_scopes text[],
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  raw_token text;
  created public.mcp_credentials;
  account_id_value uuid;
  key_limit bigint;
  active_count bigint;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'Credential name is required'; end if;
  select account_id into account_id_value
  from public.projects
  where id = p_project_id and status = 'active'
  for update;
  if account_id_value is null then
    raise exception 'Project must be active';
  end if;
  if coalesce(array_length(p_scopes, 1), 0) = 0
    or exists (select 1 from unnest(p_scopes) scope where scope not in ('openseo:*')) then
    raise exception 'Unsupported MCP scope';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Expiration must be in the future'; end if;

  key_limit := public.effective_account_limit(account_id_value, 'mcp_keys_per_project');
  select count(*) into active_count
  from public.mcp_credentials
  where project_id = p_project_id
    and revoked_at is null
    and (expires_at is null or expires_at > now());
  if key_limit is not null and active_count >= key_limit then raise exception 'MCP credential limit reached'; end if;

  raw_token := 'spc_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.mcp_credentials (project_id, created_by, name, token_hash, scopes, expires_at)
  values (
    p_project_id,
    auth.uid(),
    trim(p_name),
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    array(select distinct scope from unnest(p_scopes) scope order by scope),
    p_expires_at
  )
  returning * into created;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, p_project_id, auth.uid(), 'mcp.credential.created', 'mcp_credential', created.id::text, jsonb_build_object('scopes', created.scopes, 'expires_at', created.expires_at));

  return jsonb_build_object(
    'id', created.id,
    'name', created.name,
    'token', raw_token,
    'scopes', created.scopes,
    'expires_at', created.expires_at,
    'created_at', created.created_at
  );
end;
$$;

create or replace function public.revoke_mcp_credential(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  credential public.mcp_credentials;
  account_id_value uuid;
begin
  select * into credential from public.mcp_credentials where id = p_credential_id for update;
  if credential.id is null or not public.is_project_owner(credential.project_id) then
    raise exception 'Project owner access required';
  end if;
  if credential.revoked_at is null then
    update public.mcp_credentials set revoked_at = now() where id = credential.id;
    select account_id into account_id_value from public.projects where id = credential.project_id;
    insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
    values (account_id_value, credential.project_id, auth.uid(), 'mcp.credential.revoked', 'mcp_credential', credential.id::text);
  end if;
end;
$$;

create or replace function public.exchange_mcp_credential(
  p_token text,
  p_service_slug text,
  p_service_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  credential record;
begin
  select
    key.id,
    key.project_id,
    key.created_by as user_id,
    key.scopes,
    project.account_id,
    project.name as project_name,
    project.slug as project_slug,
    profile.email,
    membership.role
  into credential
  from public.mcp_credentials key
  join public.projects project on project.id = key.project_id and project.status = 'active'
  join public.accounts account on account.id = project.account_id and account.status = 'active'
  join public.profiles profile on profile.id = key.created_by
  join public.project_memberships membership
    on membership.project_id = project.id
   and membership.user_id = key.created_by
   and membership.status = 'active'
  join public.spaces_services service on service.slug = p_service_slug and service.status = 'active'
  join public.service_auth_secrets service_secret on service_secret.service_id = service.id
  join public.project_services project_service
    on project_service.project_id = project.id
   and project_service.service_id = service.id
   and project_service.status = 'ready'
  where key.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and key.revoked_at is null
    and (key.expires_at is null or key.expires_at > now())
    and service_secret.token_hash = extensions.digest(coalesce(p_service_secret, ''), 'sha256')
    and ((service.slug || ':*') = any(key.scopes))
  for update of key;

  if credential.id is null then raise exception 'Invalid or expired MCP credential'; end if;
  update public.mcp_credentials set last_used_at = now() where id = credential.id;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (credential.account_id, credential.project_id, credential.user_id, 'mcp.credential.used', 'mcp_credential', credential.id::text, jsonb_build_object('service', p_service_slug));

  return jsonb_build_object(
    'credential_id', credential.id,
    'user_id', credential.user_id,
    'email', credential.email,
    'project_id', credential.project_id,
    'project_name', credential.project_name,
    'project_slug', credential.project_slug,
    'role', credential.role,
    'scopes', credential.scopes
  );
end;
$$;

revoke execute on function public.create_mcp_credential(uuid, text, text[], timestamptz) from public, anon;
revoke execute on function public.revoke_mcp_credential(uuid) from public, anon;
revoke execute on function public.exchange_mcp_credential(text, text, text) from public;
grant execute on function public.create_mcp_credential(uuid, text, text[], timestamptz) to authenticated;
grant execute on function public.revoke_mcp_credential(uuid) to authenticated;
grant execute on function public.exchange_mcp_credential(text, text, text) to anon, authenticated;
