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
