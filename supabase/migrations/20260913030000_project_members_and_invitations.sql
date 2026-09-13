create table if not exists public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role = 'member'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sending', 'sent', 'failed')),
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  delivery_run_after timestamptz not null default now(),
  delivery_error text,
  invited_by uuid not null references auth.users(id) on delete restrict,
  accepted_by uuid references auth.users(id) on delete restrict,
  expires_at timestamptz not null default (now() + interval '7 days'),
  sent_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(trim(email)))
);

create unique index if not exists project_invitations_pending_email_unique
  on public.project_invitations (project_id, email)
  where status = 'pending';

create index if not exists project_invitations_delivery_idx
  on public.project_invitations (delivery_status, delivery_run_after)
  where status = 'pending' and delivery_status in ('pending', 'failed');

alter table public.project_invitations enable row level security;

create policy "Project members can read invitations"
  on public.project_invitations for select
  using (
    public.is_project_owner(project_id)
    or (status = 'pending' and email = lower(coalesce(auth.jwt()->>'email', '')))
  );

revoke insert, update, delete on public.project_invitations from anon, authenticated;

create or replace function public.create_project_invitation(p_project_id uuid, p_email text)
returns public.project_invitations
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_email text := lower(trim(coalesce(p_email, '')));
  target_account_id uuid;
  member_limit bigint;
  current_members bigint;
  pending_members bigint;
  billing_mode_value text;
  paid_seats integer;
  active_seats bigint;
  pending_seats bigint;
  target_is_account_member boolean;
  result public.project_invitations;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Valid email is required';
  end if;

  select account_id into target_account_id
  from public.projects
  where id = p_project_id and status = 'active'
  for update;
  if target_account_id is null then raise exception 'Project is unavailable'; end if;
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;

  if exists (
    select 1
    from public.project_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.project_id = p_project_id
      and membership.status = 'active'
      and lower(profile.email) = normalized_email
  ) then
    raise exception 'User is already a project member';
  end if;

  member_limit := public.effective_account_limit(target_account_id, 'project_members');
  if member_limit is not null then
    select count(*) into current_members
    from public.project_memberships
    where project_id = p_project_id and status = 'active';
    select count(*) into pending_members
    from public.project_invitations
    where project_id = p_project_id and status = 'pending' and expires_at > now();
    if current_members + pending_members >= member_limit then
      raise exception 'Project member limit reached';
    end if;
  end if;

  select plan.billing_mode, subscription.seats
  into billing_mode_value, paid_seats
  from public.account_subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.account_id = target_account_id;

  select exists (
    select 1
    from public.account_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.account_id = target_account_id
      and membership.status = 'active'
      and lower(profile.email) = normalized_email
  ) into target_is_account_member;

  if billing_mode_value = 'seat' and not target_is_account_member then
    select count(*) into active_seats
    from public.account_memberships
    where account_id = target_account_id and status = 'active';

    select count(distinct invitation.email) into pending_seats
    from public.project_invitations invitation
    join public.projects project on project.id = invitation.project_id
    where project.account_id = target_account_id
      and invitation.status = 'pending'
      and invitation.expires_at > now()
      and not exists (
        select 1
        from public.account_memberships membership
        join public.profiles profile on profile.id = membership.user_id
        where membership.account_id = target_account_id
          and membership.status = 'active'
          and lower(profile.email) = invitation.email
      );

    if active_seats + pending_seats >= paid_seats then
      raise exception 'Corporate seat limit reached';
    end if;
  end if;

  insert into public.project_invitations (project_id, email, invited_by)
  values (p_project_id, normalized_email, current_user_id)
  returning * into result;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (target_account_id, p_project_id, current_user_id, 'project.invitation.created', 'project_invitation', result.id::text, jsonb_build_object('email', normalized_email));

  return result;
exception
  when unique_violation then raise exception 'A pending invitation already exists';
end;
$$;

create or replace function public.get_project_access(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  membership_role text;
  members jsonb;
  invitations jsonb := '[]'::jsonb;
begin
  select role into membership_role
  from public.project_memberships
  where project_id = p_project_id and user_id = auth.uid() and status = 'active';
  if membership_role is null then raise exception 'Project access required'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', membership.user_id,
    'role', membership.role,
    'status', membership.status,
    'email', profile.email,
    'display_name', profile.display_name,
    'avatar_url', profile.avatar_url,
    'created_at', membership.created_at
  ) order by (membership.role = 'owner') desc, profile.display_name, profile.email), '[]'::jsonb)
  into members
  from public.project_memberships membership
  join public.profiles profile on profile.id = membership.user_id
  where membership.project_id = p_project_id and membership.status = 'active';

  if membership_role = 'owner' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', invitation.id,
      'email', invitation.email,
      'role', invitation.role,
      'status', invitation.status,
      'delivery_status', invitation.delivery_status,
      'delivery_error', invitation.delivery_error,
      'expires_at', invitation.expires_at,
      'created_at', invitation.created_at
    ) order by invitation.created_at desc), '[]'::jsonb)
    into invitations
    from public.project_invitations invitation
    where invitation.project_id = p_project_id
      and invitation.status = 'pending'
      and invitation.expires_at > now();
  end if;

  return jsonb_build_object('role', membership_role, 'members', members, 'invitations', invitations);
end;
$$;

create or replace function public.list_my_project_invitations()
returns table (
  invitation_id uuid,
  project_id uuid,
  project_name text,
  account_id uuid,
  account_name text,
  invited_by_name text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select invitation.id, project.id, project.name, account.id, account.name,
    coalesce(inviter.display_name, inviter.email), invitation.expires_at
  from public.project_invitations invitation
  join public.projects project on project.id = invitation.project_id and project.status = 'active'
  join public.accounts account on account.id = project.account_id and account.status = 'active'
  left join public.profiles inviter on inviter.id = invitation.invited_by
  where auth.uid() is not null
    and invitation.status = 'pending'
    and invitation.expires_at > now()
    and invitation.email = lower(coalesce(auth.jwt()->>'email', ''))
  order by invitation.created_at desc;
$$;

create or replace function public.accept_project_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text := lower(coalesce(auth.jwt()->>'email', ''));
  invitation public.project_invitations;
  target_account_id uuid;
  billing_mode_value text;
  paid_seats integer;
  active_seats bigint;
  already_account_member boolean;
begin
  if current_user_id is null or current_email = '' then raise exception 'Authentication required'; end if;

  select * into invitation
  from public.project_invitations
  where id = p_invitation_id
  for update;
  if invitation.id is null or invitation.status <> 'pending' then raise exception 'Invitation is unavailable'; end if;
  if invitation.expires_at <= now() then
    update public.project_invitations set status = 'expired', updated_at = now() where id = invitation.id;
    raise exception 'Invitation has expired';
  end if;
  if invitation.email <> current_email then raise exception 'Invitation belongs to another email'; end if;

  select account_id into target_account_id
  from public.projects
  where id = invitation.project_id and status = 'active';
  if target_account_id is null then raise exception 'Project is unavailable'; end if;

  select exists (
    select 1 from public.account_memberships
    where account_id = target_account_id and user_id = current_user_id and status = 'active'
  ) into already_account_member;

  select plan.billing_mode, subscription.seats
  into billing_mode_value, paid_seats
  from public.account_subscriptions subscription
  join public.plans plan on plan.id = subscription.plan_id
  where subscription.account_id = target_account_id;

  if billing_mode_value = 'seat' and not already_account_member then
    select count(*) into active_seats
    from public.account_memberships
    where account_id = target_account_id and status = 'active';
    if active_seats >= paid_seats then raise exception 'Corporate seat limit reached'; end if;
  end if;

  insert into public.account_memberships (account_id, user_id, role, status)
  values (target_account_id, current_user_id, 'member', 'active')
  on conflict (account_id, user_id) do update set
    role = case when public.account_memberships.role = 'owner' then 'owner' else 'member' end,
    status = 'active',
    updated_at = now();

  insert into public.project_memberships (project_id, user_id, role, status)
  values (invitation.project_id, current_user_id, 'member', 'active')
  on conflict (project_id, user_id) do update set
    role = case when public.project_memberships.role = 'owner' then 'owner' else 'member' end,
    status = 'active',
    updated_at = now();

  update public.project_invitations set
    status = 'accepted',
    accepted_by = current_user_id,
    accepted_at = now(),
    updated_at = now()
  where id = invitation.id;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (target_account_id, invitation.project_id, current_user_id, 'project.invitation.accepted', 'project_invitation', invitation.id::text, jsonb_build_object('email', current_email));

  return jsonb_build_object('account_id', target_account_id, 'project_id', invitation.project_id);
end;
$$;

create or replace function public.revoke_project_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.project_invitations;
  target_account_id uuid;
begin
  select * into invitation from public.project_invitations where id = p_invitation_id for update;
  if invitation.id is null or invitation.status <> 'pending' then raise exception 'Invitation is unavailable'; end if;
  if not public.is_project_owner(invitation.project_id) then raise exception 'Project owner access required'; end if;
  select account_id into target_account_id from public.projects where id = invitation.project_id;
  update public.project_invitations set status = 'revoked', updated_at = now() where id = invitation.id;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (target_account_id, invitation.project_id, auth.uid(), 'project.invitation.revoked', 'project_invitation', invitation.id::text, jsonb_build_object('email', invitation.email));
end;
$$;

create or replace function public.remove_project_member(p_project_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account_id uuid;
  target_role text;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select account_id into target_account_id from public.projects where id = p_project_id and status = 'active';
  if target_account_id is null then raise exception 'Project is unavailable'; end if;
  select role into target_role from public.project_memberships where project_id = p_project_id and user_id = p_user_id and status = 'active' for update;
  if target_role is null then raise exception 'Project member not found'; end if;
  if target_role = 'owner' then raise exception 'Project owner cannot be removed'; end if;

  update public.project_memberships set status = 'archived', updated_at = now()
  where project_id = p_project_id and user_id = p_user_id;

  if not exists (
    select 1
    from public.project_memberships membership
    join public.projects project on project.id = membership.project_id
    where project.account_id = target_account_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
      and project.status = 'active'
  ) then
    update public.account_memberships set status = 'archived', updated_at = now()
    where account_id = target_account_id and user_id = p_user_id and role <> 'owner';
  end if;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (target_account_id, p_project_id, auth.uid(), 'project.member.removed', 'user', p_user_id::text);
end;
$$;

create or replace function public.claim_project_invitation_deliveries(p_limit integer default 10)
returns table (invitation_id uuid, email text, user_exists boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  return query
  with claimed as (
    select invitation.id
    from public.project_invitations invitation
    where invitation.status = 'pending'
      and invitation.expires_at > now()
      and invitation.delivery_status in ('pending', 'failed')
      and invitation.delivery_attempts < 5
      and invitation.delivery_run_after <= now()
    order by invitation.created_at
    for update skip locked
    limit greatest(least(p_limit, 50), 1)
  ), updated as (
    update public.project_invitations invitation set
      delivery_status = 'sending',
      delivery_attempts = invitation.delivery_attempts + 1,
      delivery_error = null,
      updated_at = now()
    from claimed
    where invitation.id = claimed.id
    returning invitation.id, invitation.email
  )
  select updated.id, updated.email, exists (
    select 1 from public.profiles profile where lower(profile.email) = updated.email
  )
  from updated;
end;
$$;

create or replace function public.complete_project_invitation_delivery(p_invitation_id uuid, p_success boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.project_invitations set
    delivery_status = case when p_success then 'sent' else 'failed' end,
    sent_at = case when p_success then now() else sent_at end,
    delivery_error = case when p_success then null else left(coalesce(p_error, 'Delivery failed'), 1000) end,
    delivery_run_after = case when p_success then delivery_run_after else now() + make_interval(secs => least(3600, (power(2, delivery_attempts) * 30)::integer)) end,
    updated_at = now()
  where id = p_invitation_id and status = 'pending' and delivery_status = 'sending';
end;
$$;

create or replace function public.expire_project_invitations()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  affected bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.project_invitations set status = 'expired', updated_at = now()
  where status = 'pending' and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke execute on function public.create_project_invitation(uuid, text) from public, anon;
revoke execute on function public.get_project_access(uuid) from public, anon;
revoke execute on function public.list_my_project_invitations() from public, anon;
revoke execute on function public.accept_project_invitation(uuid) from public, anon;
revoke execute on function public.revoke_project_invitation(uuid) from public, anon;
revoke execute on function public.remove_project_member(uuid, uuid) from public, anon;
revoke execute on function public.claim_project_invitation_deliveries(integer) from public, anon, authenticated;
revoke execute on function public.complete_project_invitation_delivery(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.expire_project_invitations() from public, anon, authenticated;

grant execute on function public.create_project_invitation(uuid, text) to authenticated;
grant execute on function public.get_project_access(uuid) to authenticated;
grant execute on function public.list_my_project_invitations() to authenticated;
grant execute on function public.accept_project_invitation(uuid) to authenticated;
grant execute on function public.revoke_project_invitation(uuid) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid) to authenticated;
grant execute on function public.claim_project_invitation_deliveries(integer) to service_role;
grant execute on function public.complete_project_invitation_delivery(uuid, boolean, text) to service_role;
grant execute on function public.expire_project_invitations() to service_role;
