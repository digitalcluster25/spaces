create or replace function public.is_superadmin_identity(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select check_user_id = auth.uid() and exists (
    select 1
    from public.profiles
    where id = check_user_id
      and is_superadmin
      and lower(email) = 'digitalcluster25@gmail.com'
  );
$$;

create or replace function public.is_superadmin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin_identity(check_user_id)
    and coalesce(auth.jwt()->>'aal', '') = 'aal2';
$$;

create or replace function public.is_account_member(check_account_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.account_memberships
    where account_id = check_account_id
      and user_id = check_user_id
      and status = 'active'
      and (
        not public.is_superadmin_identity(check_user_id)
        or coalesce(auth.jwt()->>'aal', '') = 'aal2'
      )
  );
$$;

create or replace function public.is_account_owner(check_account_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.account_memberships
    where account_id = check_account_id
      and user_id = check_user_id
      and role = 'owner'
      and status = 'active'
      and (
        not public.is_superadmin_identity(check_user_id)
        or coalesce(auth.jwt()->>'aal', '') = 'aal2'
      )
  );
$$;

create or replace function public.is_project_member(check_project_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_memberships
    where project_id = check_project_id
      and user_id = check_user_id
      and status = 'active'
      and (
        not public.is_superadmin_identity(check_user_id)
        or coalesce(auth.jwt()->>'aal', '') = 'aal2'
      )
  );
$$;

create or replace function public.is_project_owner(check_project_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_memberships
    where project_id = check_project_id
      and user_id = check_user_id
      and role = 'owner'
      and status = 'active'
      and (
        not public.is_superadmin_identity(check_user_id)
        or coalesce(auth.jwt()->>'aal', '') = 'aal2'
      )
  );
$$;

revoke execute on function public.is_superadmin_identity(uuid) from anon;
