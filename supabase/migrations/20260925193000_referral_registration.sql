create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now(),
  check (code = lower(code) and code ~ '^[0-9a-f]{20}$')
);

create table if not exists public.referral_signup_reservations (
  email text primary key,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('referral_code', 'project_invitation')),
  source_id uuid,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  referred_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(trim(email)))
);

create index if not exists referral_signup_reservations_expiry_idx
  on public.referral_signup_reservations (expires_at)
  where consumed_at is null;

create table if not exists public.referrals (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete restrict,
  source text not null check (source in ('referral_code', 'project_invitation')),
  created_at timestamptz not null default now(),
  check (referred_user_id <> referrer_user_id)
);

create index if not exists referrals_referrer_created_idx
  on public.referrals (referrer_user_id, created_at desc);

alter table public.referral_codes enable row level security;
alter table public.referral_signup_reservations enable row level security;
alter table public.referrals enable row level security;

create policy "Users can read their own referral code"
  on public.referral_codes for select to authenticated
  using (auth.uid() = user_id);

create policy "Referrers can read their referrals"
  on public.referrals for select to authenticated
  using (auth.uid() = referrer_user_id);

create policy "Auth hook can read signup reservations"
  on public.referral_signup_reservations for select to supabase_auth_admin
  using (true);

revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referral_signup_reservations from anon, authenticated;
revoke all on public.referrals from anon, authenticated;
grant select on public.referral_codes to authenticated;
grant select on public.referrals to authenticated;
grant select on public.referral_signup_reservations to supabase_auth_admin;

create or replace function public.ensure_referral_code(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  existing_code text;
  candidate text;
begin
  select code into existing_code from public.referral_codes where user_id = p_user_id;
  if existing_code is not null then return existing_code; end if;

  for attempt in 1..5 loop
    candidate := lower(encode(extensions.gen_random_bytes(10), 'hex'));
    begin
      insert into public.referral_codes (user_id, code) values (p_user_id, candidate);
      return candidate;
    exception when unique_violation then
      null;
    end;
  end loop;

  raise exception 'Could not allocate referral code';
end;
$$;

revoke execute on function public.ensure_referral_code(uuid) from public, anon, authenticated;

create or replace function public.reserve_referral_signup(p_email text, p_code text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(p_email, '')));
  normalized_code text := lower(trim(coalesce(p_code, '')));
  referrer_id uuid;
  reservation_expiry timestamptz := now() + interval '30 minutes';
begin
  if normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Valid email is required';
  end if;

  select user_id into referrer_id
  from public.referral_codes
  where code = normalized_code;

  if referrer_id is null then raise exception 'Referral code is invalid'; end if;
  if auth.uid() = referrer_id then raise exception 'Self-referral is not allowed'; end if;
  if exists (
    select 1
    from public.referral_signup_reservations
    where email = normalized_email and consumed_at is not null
  ) then
    raise exception 'Referral attribution is already fixed';
  end if;

  insert into public.referral_signup_reservations (
    email, referrer_user_id, source, source_id, expires_at, consumed_at, referred_user_id, updated_at
  ) values (
    normalized_email, referrer_id, 'referral_code', null, reservation_expiry, null, null, now()
  )
  on conflict (email) do update set
    referrer_user_id = excluded.referrer_user_id,
    source = excluded.source,
    source_id = null,
    expires_at = excluded.expires_at,
    consumed_at = null,
    referred_user_id = null,
    updated_at = now()
  where public.referral_signup_reservations.consumed_at is null;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'referral.signup.reserved', 'referrer', referrer_id::text, jsonb_build_object('source', 'referral_code'));

  return reservation_expiry;
end;
$$;

revoke execute on function public.reserve_referral_signup(text, text) from public;
grant execute on function public.reserve_referral_signup(text, text) to anon, authenticated;

create or replace function public.prepare_project_invitation_signup(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.project_invitations;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;

  select * into invitation
  from public.project_invitations
  where id = p_invitation_id
    and status = 'pending'
    and expires_at > now();

  if invitation.id is null then raise exception 'Project invitation is unavailable'; end if;

  insert into public.referral_signup_reservations (
    email, referrer_user_id, source, source_id, expires_at, updated_at
  ) values (
    invitation.email,
    invitation.invited_by,
    'project_invitation',
    invitation.id,
    least(invitation.expires_at, now() + interval '30 minutes'),
    now()
  )
  on conflict (email) do update set
    referrer_user_id = excluded.referrer_user_id,
    source = excluded.source,
    source_id = excluded.source_id,
    expires_at = excluded.expires_at,
    consumed_at = null,
    referred_user_id = null,
    updated_at = now()
  where public.referral_signup_reservations.consumed_at is null
    and (public.referral_signup_reservations.expires_at <= now()
      or public.referral_signup_reservations.source_id = p_invitation_id);
end;
$$;

revoke execute on function public.prepare_project_invitation_signup(uuid) from public, anon, authenticated;
grant execute on function public.prepare_project_invitation_signup(uuid) to service_role;

create or replace function public.hook_require_referral_signup(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  normalized_email text := lower(trim(coalesce(event->'user'->>'email', '')));
begin
  if normalized_email <> '' and exists (
    select 1
    from public.referral_signup_reservations reservation
    where reservation.email = normalized_email
      and reservation.consumed_at is null
      and reservation.expires_at > now()
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Для регистрации нужна действующая реферальная ссылка или код.',
      'http_code', 403
    )
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_require_referral_signup(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_require_referral_signup(jsonb) from public, anon, authenticated;

create or replace function public.handle_new_user_referral()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation public.referral_signup_reservations;
begin
  perform public.ensure_referral_code(new.id);

  select * into reservation
  from public.referral_signup_reservations
  where email = lower(trim(new.email))
    and consumed_at is null
    and expires_at > now()
  for update;

  if reservation.email is null or reservation.referrer_user_id = new.id then return new; end if;

  insert into public.referrals (referred_user_id, referrer_user_id, source)
  values (new.id, reservation.referrer_user_id, reservation.source)
  on conflict (referred_user_id) do nothing;

  update public.referral_signup_reservations set
    consumed_at = now(),
    referred_user_id = new.id,
    updated_at = now()
  where email = reservation.email and consumed_at is null;

  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (
    new.id,
    'referral.signup.completed',
    'user',
    new.id::text,
    jsonb_build_object('referrer_user_id', reservation.referrer_user_id, 'source', reservation.source)
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_referral_created on auth.users;
create trigger on_auth_user_referral_created
  after insert on auth.users
  for each row execute function public.handle_new_user_referral();

create or replace function public.get_my_referral_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  referral_code text;
  invited jsonb;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;

  select code into referral_code from public.referral_codes where user_id = current_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'display_name', coalesce(nullif(profile.display_name, ''), 'Пользователь Spaces'),
    'masked_email', case
      when profile.email is null then null
      else left(split_part(profile.email, '@', 1), 1) || '***@' || split_part(profile.email, '@', 2)
    end,
    'joined_at', referral.created_at
  ) order by referral.created_at desc), '[]'::jsonb)
  into invited
  from public.referrals referral
  join public.profiles profile on profile.id = referral.referred_user_id
  where referral.referrer_user_id = current_user_id;

  return jsonb_build_object(
    'code', referral_code,
    'link', case when referral_code is null then null else 'https://spaces.community/register?ref=' || referral_code end,
    'count', jsonb_array_length(invited),
    'invited', invited
  );
end;
$$;

revoke execute on function public.get_my_referral_overview() from public, anon;
grant execute on function public.get_my_referral_overview() to authenticated;

do $$
declare
  existing_user record;
begin
  for existing_user in select id from auth.users loop
    perform public.ensure_referral_code(existing_user.id);
  end loop;
end;
$$;
