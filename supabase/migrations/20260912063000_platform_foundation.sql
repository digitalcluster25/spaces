create extension if not exists pgcrypto with schema extensions;

alter table public.profiles
  add column if not exists is_superadmin boolean not null default false,
  add column if not exists active_project_id uuid,
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '14 days');

create unique index if not exists profiles_single_superadmin
  on public.profiles (is_superadmin)
  where is_superadmin;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null,
  slug text not null unique,
  account_type text not null default 'personal' check (account_type in ('personal', 'corporate')),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists accounts_personal_owner_unique
  on public.accounts (owner_id)
  where account_type = 'personal';

create table if not exists public.account_memberships (
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  logo_url text,
  status text not null default 'active' check (status in ('active', 'archived', 'deleting')),
  is_system boolean not null default false,
  system_key text unique,
  archived_at timestamptz,
  purge_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, slug)
);

create unique index if not exists projects_account_name_unique
  on public.projects (account_id, lower(name));

create table if not exists public.project_memberships (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('owner', 'member')),
  status text not null default 'active' check (status in ('active', 'invited', 'suspended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

alter table public.spaces_services
  add column if not exists base_url text,
  add column if not exists mcp_url text,
  add column if not exists auth_mode text not null default 'spaces_ticket',
  add column if not exists is_core boolean not null default false,
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists sort_order integer not null default 100,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.project_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  service_id uuid not null references public.spaces_services(id) on delete restrict,
  status text not null default 'provisioning' check (
    status in ('provisioning', 'ready', 'error', 'disabled', 'suspended', 'archived')
  ),
  status_before_archive text,
  external_tenant_id text,
  external_tenant_name text,
  last_error text,
  retry_count integer not null default 0,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, service_id)
);

create table if not exists public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  project_service_id uuid not null references public.project_services(id) on delete cascade,
  operation text not null check (operation in ('provision', 'suspend', 'resume', 'archive', 'restore', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists provisioning_jobs_pending_idx
  on public.provisioning_jobs (status, run_after)
  where status in ('pending', 'failed');

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'USD',
  billing_period text check (billing_period in ('month', 'year')),
  billing_mode text not null default 'account' check (billing_mode in ('account', 'seat', 'internal')),
  is_active boolean not null default true,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_limits (
  plan_id uuid not null references public.plans(id) on delete cascade,
  key text not null,
  value bigint,
  unit text not null default 'count',
  status text not null default 'active' check (status in ('active', 'reserve')),
  description text,
  updated_at timestamptz not null default now(),
  primary key (plan_id, key)
);

create table if not exists public.account_subscriptions (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete restrict,
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  seats integer not null default 1 check (seats > 0),
  creem_customer_id text unique,
  creem_subscription_id text unique,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_limit_overrides (
  account_id uuid not null references public.accounts(id) on delete cascade,
  key text not null,
  value bigint,
  reason text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (account_id, key)
);

create table if not exists public.harness_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.harness_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.harness_templates(id) on delete cascade,
  version integer not null check (version > 0),
  admin_config jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  git_revision text,
  status text not null default 'draft' check (status in ('draft', 'testing', 'published', 'failed', 'archived')),
  test_report jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (template_id, version)
);

create table if not exists public.project_harness_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  template_id uuid references public.harness_templates(id) on delete restrict,
  active_version_id uuid references public.harness_versions(id) on delete restrict,
  offered_version_id uuid references public.harness_versions(id) on delete set null,
  user_config jsonb not null default '{}'::jsonb,
  conflict_report jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  account_id uuid references public.accounts(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_project_created_idx
  on public.audit_events (project_id, created_at desc);

create table if not exists public.mcp_credentials (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  name text not null,
  token_hash text not null unique,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.is_superadmin(check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = check_user_id
      and is_superadmin
      and lower(email) = 'digitalcluster25@gmail.com'
  );
$$;

create or replace function public.is_account_member(check_account_id uuid, check_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.account_memberships
    where account_id = check_account_id and user_id = check_user_id and status = 'active'
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
    select 1 from public.account_memberships
    where account_id = check_account_id and user_id = check_user_id and role = 'owner' and status = 'active'
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
    select 1 from public.project_memberships
    where project_id = check_project_id and user_id = check_user_id and status = 'active'
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
    select 1 from public.project_memberships
    where project_id = check_project_id and user_id = check_user_id and role = 'owner' and status = 'active'
  );
$$;

create or replace function public.make_project_slug(raw_name text)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  result text;
begin
  result := trim(both '-' from regexp_replace(lower(raw_name), '[^a-z0-9]+', '-', 'g'));
  if result = '' then
    result := 'project-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;
  return left(result, 80);
end;
$$;

create or replace function public.effective_account_limit(check_account_id uuid, limit_key text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select value from public.account_limit_overrides where account_id = check_account_id and key = limit_key),
    (
      select pl.value
      from public.account_subscriptions s
      join public.plan_limits pl on pl.plan_id = s.plan_id
      where s.account_id = check_account_id and pl.key = limit_key and pl.status = 'active'
    )
  );
$$;

create or replace function public.protect_platform_roots()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'profiles' then
    if tg_op = 'DELETE' and old.is_superadmin then
      raise exception 'The Spaces superadmin cannot be deleted';
    end if;
    if tg_op = 'UPDATE' and (
      new.is_superadmin is distinct from old.is_superadmin
      or (old.is_superadmin and (new.id is distinct from old.id or lower(new.email) <> 'digitalcluster25@gmail.com'))
    ) then
      raise exception 'The Spaces superadmin identity is immutable';
    end if;
    if tg_op = 'UPDATE'
      and new.active_project_id is distinct from old.active_project_id
      and new.active_project_id is not null
      and not exists (
        select 1 from public.project_memberships
        where project_id = new.active_project_id
          and user_id = new.id
          and status = 'active'
      ) then
      raise exception 'The active project must belong to the user';
    end if;
  elsif tg_table_name = 'projects' then
    if old.is_system and old.system_key = 'spaces-root' then
      if tg_op = 'DELETE' then
        raise exception 'The Spaces root project cannot be deleted';
      end if;
      if new.name is distinct from old.name
        or new.slug is distinct from old.slug
        or new.owner_id is distinct from old.owner_id
        or new.account_id is distinct from old.account_id
        or new.status is distinct from old.status
        or new.is_system is distinct from old.is_system
        or new.system_key is distinct from old.system_key then
        raise exception 'The Spaces root project is immutable';
      end if;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

insert into public.plans (code, name, price_cents, billing_period, billing_mode, is_public)
values
  ('trial', 'Пробный период', 0, null, 'account', false),
  ('golden', 'Золотой стандарт', 1000, 'month', 'account', true),
  ('corporate', 'Корпоративный', 1000, 'month', 'seat', true),
  ('internal', 'Spaces Internal', 0, null, 'internal', false)
on conflict (code) do update set
  name = excluded.name,
  price_cents = excluded.price_cents,
  billing_period = excluded.billing_period,
  billing_mode = excluded.billing_mode,
  is_public = excluded.is_public,
  updated_at = now();

insert into public.plan_limits (plan_id, key, value, unit, status, description)
select p.id, v.key, v.value, v.unit, v.status, v.description
from public.plans p
join (values
  ('trial', 'active_projects', 1::bigint, 'count', 'active', 'Активные проекты'),
  ('trial', 'archive_retention_days', 10::bigint, 'days', 'active', 'Срок восстановления'),
  ('golden', 'active_projects', 10::bigint, 'count', 'active', 'Активные проекты'),
  ('golden', 'archived_projects', 25::bigint, 'count', 'active', 'Архивные проекты'),
  ('golden', 'project_members', 5::bigint, 'count', 'reserve', 'Участники проекта'),
  ('golden', 'mcp_keys_per_project', 5::bigint, 'count', 'reserve', 'MCP-ключи проекта'),
  ('golden', 'connected_agents_per_project', 10::bigint, 'count', 'reserve', 'Подключённые агенты'),
  ('golden', 'mcp_requests_month', 20000::bigint, 'requests', 'reserve', 'MCP-запросы в месяц'),
  ('golden', 'automation_runs_month', 1000::bigint, 'runs', 'reserve', 'Запуски автоматизаций'),
  ('golden', 'harness_versions_per_project', 100::bigint, 'count', 'reserve', 'Версии Harness'),
  ('golden', 'harness_evals_month', 500::bigint, 'runs', 'reserve', 'Контрольные прогоны Harness'),
  ('golden', 'file_storage_mb', 5120::bigint, 'megabytes', 'reserve', 'Файловое хранилище'),
  ('golden', 'vector_storage_mb', 2048::bigint, 'megabytes', 'reserve', 'Векторный контекст'),
  ('golden', 'trigger_emails_month', 2000::bigint, 'emails', 'reserve', 'Триггерные письма'),
  ('golden', 'archive_retention_days', 60::bigint, 'days', 'active', 'Срок восстановления'),
  ('corporate', 'active_projects', 10::bigint, 'count', 'active', 'Активные проекты'),
  ('corporate', 'archived_projects', 25::bigint, 'count', 'active', 'Архивные проекты'),
  ('corporate', 'project_members', null::bigint, 'count', 'active', 'Участники оплачиваются по местам'),
  ('corporate', 'archive_retention_days', 60::bigint, 'days', 'active', 'Срок восстановления'),
  ('internal', 'active_projects', null::bigint, 'count', 'active', 'Без ограничений'),
  ('internal', 'archive_retention_days', null::bigint, 'days', 'active', 'Без ограничений')
) as v(plan_code, key, value, unit, status, description) on p.code = v.plan_code
on conflict (plan_id, key) do update set
  value = excluded.value,
  unit = excluded.unit,
  status = excluded.status,
  description = excluded.description,
  updated_at = now();

insert into public.spaces_services (
  slug, name, subdomain, description, status, base_url, mcp_url, auth_mode, is_core, capabilities, sort_order
)
values
  ('spaces', 'Spaces', 'spaces.community', 'Управляющее ядро платформы', 'active', 'https://spaces.community', null, 'spaces_session', true, '{"tenant":true,"provisioning":false}'::jsonb, 0),
  ('openseo', 'OpenSEO', 'openseo.spaces.community', 'SEO workflows, DataForSEO, Google Search Console и MCP', 'active', 'https://openseo.spaces.community', 'https://openseo.spaces.community/mcp', 'spaces_ticket', false, '{"tenant":true,"mcp":true}'::jsonb, 10),
  ('outline', 'Outline', 'outline.spaces.community', 'База знаний и проектная документация', 'active', 'https://outline.spaces.community', null, 'spaces_ticket', false, '{"tenant":true,"documents":true}'::jsonb, 20)
on conflict (slug) do update set
  name = excluded.name,
  subdomain = excluded.subdomain,
  description = excluded.description,
  status = excluded.status,
  base_url = excluded.base_url,
  mcp_url = excluded.mcp_url,
  auth_mode = excluded.auth_mode,
  is_core = excluded.is_core,
  capabilities = excluded.capabilities,
  sort_order = excluded.sort_order,
  updated_at = now();

create or replace function public.ensure_personal_account(p_user_id uuid, p_user_email text, p_user_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  result uuid;
  account_slug text;
  trial_plan_id uuid;
begin
  select id into result from public.accounts where owner_id = p_user_id and account_type = 'personal';
  if result is not null then return result; end if;

  account_slug := 'account-' || left(replace(p_user_id::text, '-', ''), 12);
  insert into public.accounts (owner_id, name, slug)
  values (p_user_id, coalesce(nullif(p_user_name, ''), split_part(p_user_email, '@', 1)), account_slug)
  returning id into result;

  insert into public.account_memberships (account_id, user_id, role)
  values (result, p_user_id, 'owner');

  select id into trial_plan_id from public.plans where code = 'trial';
  insert into public.account_subscriptions (account_id, plan_id, status, trial_ends_at)
  values (result, trial_plan_id, 'trialing', now() + interval '14 days');

  return result;
end;
$$;

create or replace function public.seed_spaces_projects(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account_id uuid;
  root_id uuid;
  commercial_id uuid;
  nonprofit_id uuid;
  service_record record;
  internal_plan_id uuid;
begin
  select a.id into target_account_id
  from public.accounts a
  where a.owner_id = p_user_id and a.account_type = 'personal';

  if target_account_id is null then raise exception 'Personal account is missing'; end if;

  insert into public.projects (account_id, owner_id, name, slug, description, is_system, system_key)
  values (target_account_id, p_user_id, 'Spaces', 'spaces', 'Корневой проект разработки платформы и Harness', true, 'spaces-root')
  on conflict (system_key) do update set updated_at = now()
  returning id into root_id;

  insert into public.projects (account_id, owner_id, name, slug, description)
  values (target_account_id, p_user_id, 'Коммерческие проекты', 'commercial-projects', 'Текущие коммерческие сервисы и доступы')
  on conflict (account_id, slug) do update set updated_at = now()
  returning id into commercial_id;

  insert into public.projects (account_id, owner_id, name, slug, description)
  values (target_account_id, p_user_id, 'Некоммерческие проекты', 'nonprofit-projects', 'Некоммерческие инициативы')
  on conflict (account_id, slug) do update set updated_at = now()
  returning id into nonprofit_id;

  insert into public.project_memberships (project_id, user_id, role)
  values (root_id, p_user_id, 'owner'), (commercial_id, p_user_id, 'owner'), (nonprofit_id, p_user_id, 'owner')
  on conflict (project_id, user_id) do update set role = 'owner', status = 'active', updated_at = now();

  for service_record in select id, slug from public.spaces_services where slug in ('spaces', 'outline') loop
    insert into public.project_services (project_id, service_id, status, external_tenant_name)
    values (root_id, service_record.id, 'ready', 'Spaces')
    on conflict (project_id, service_id) do nothing;
  end loop;

  for service_record in select id, slug from public.spaces_services where slug in ('spaces', 'openseo', 'outline') loop
    insert into public.project_services (project_id, service_id, status, external_tenant_name)
    values (commercial_id, service_record.id, 'ready', 'Коммерческие проекты')
    on conflict (project_id, service_id) do nothing;
  end loop;

  insert into public.project_services (project_id, service_id, status, external_tenant_name)
  select nonprofit_id, id, 'ready', 'Некоммерческие проекты'
  from public.spaces_services where slug = 'spaces'
  on conflict (project_id, service_id) do nothing;

  select id into internal_plan_id from public.plans where code = 'internal';
  update public.account_subscriptions
  set plan_id = internal_plan_id, status = 'active', trial_ends_at = null, updated_at = now()
  where public.account_subscriptions.account_id = target_account_id;

  update public.profiles set active_project_id = coalesce(active_project_id, root_id) where id = p_user_id;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id uuid;
  display_name text;
begin
  display_name := coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1));

  insert into public.profiles (id, email, display_name, avatar_url, is_superadmin)
  values (
    new.id,
    new.email,
    display_name,
    new.raw_user_meta_data->>'avatar_url',
    lower(new.email) = 'digitalcluster25@gmail.com'
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.profiles.display_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = now();

  account_id := public.ensure_personal_account(new.id, new.email, display_name);
  if lower(new.email) = 'digitalcluster25@gmail.com' then
    perform public.seed_spaces_projects(new.id);
  end if;
  return new;
end;
$$;

create or replace function public.create_project(
  project_name text,
  project_description text default null,
  project_logo_url text default null,
  enabled_service_slugs text[] default '{}'
)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  current_account_id uuid;
  project_limit bigint;
  active_count bigint;
  project_slug text;
  created_project public.projects;
  service_record record;
  connection_id uuid;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if nullif(trim(project_name), '') is null then raise exception 'Project name is required'; end if;

  select account_id into current_account_id
  from public.account_memberships
  where user_id = current_user_id and role = 'owner' and status = 'active'
  order by created_at limit 1;

  if current_account_id is null then raise exception 'Account is missing'; end if;
  if exists (select 1 from public.projects where account_id = current_account_id and lower(name) = lower(trim(project_name))) then
    raise exception 'Project name must be unique';
  end if;

  project_limit := public.effective_account_limit(current_account_id, 'active_projects');
  select count(*) into active_count from public.projects where account_id = current_account_id and status = 'active' and not is_system;
  if not public.is_superadmin(current_user_id) and project_limit is not null and active_count >= project_limit then
    raise exception 'Active project limit reached';
  end if;

  project_slug := public.make_project_slug(project_name);
  if exists (select 1 from public.projects where account_id = current_account_id and slug = project_slug) then
    project_slug := left(project_slug, 70) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;

  insert into public.projects (account_id, owner_id, name, slug, description, logo_url)
  values (current_account_id, current_user_id, trim(project_name), project_slug, project_description, project_logo_url)
  returning * into created_project;

  insert into public.project_memberships (project_id, user_id, role)
  values (created_project.id, current_user_id, 'owner');

  for service_record in
    select * from public.spaces_services
    where status = 'active' and (is_core or slug = any(enabled_service_slugs))
  loop
    insert into public.project_services (project_id, service_id, status, external_tenant_name)
    values (
      created_project.id,
      service_record.id,
      case when service_record.is_core then 'ready' else 'provisioning' end,
      created_project.name
    )
    returning id into connection_id;

    if not service_record.is_core then
      insert into public.provisioning_jobs (project_service_id, operation) values (connection_id, 'provision');
    end if;
  end loop;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (current_account_id, created_project.id, current_user_id, 'project.created', 'project', created_project.id::text);

  update public.profiles set active_project_id = created_project.id where id = current_user_id;
  return created_project;
end;
$$;

create or replace function public.update_project(
  p_project_id uuid,
  project_name text,
  project_description text default null,
  project_logo_url text default null
)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.projects;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  if exists (select 1 from public.projects where id = p_project_id and is_system) then raise exception 'System project is immutable'; end if;
  if nullif(trim(project_name), '') is null then raise exception 'Project name is required'; end if;
  if exists (
    select 1 from public.projects p
    join public.projects current on current.id = p_project_id
    where p.account_id = current.account_id and p.id <> p_project_id and lower(p.name) = lower(trim(project_name))
  ) then raise exception 'Project name must be unique'; end if;

  update public.projects set
    name = trim(project_name),
    description = project_description,
    logo_url = project_logo_url,
    updated_at = now()
  where id = p_project_id
  returning * into result;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (result.account_id, result.id, auth.uid(), 'project.updated', 'project', result.id::text);
  return result;
end;
$$;

create or replace function public.archive_project(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.projects;
  retention_days bigint;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  if exists (select 1 from public.projects where id = p_project_id and is_system) then raise exception 'System project cannot be archived'; end if;

  select public.effective_account_limit(account_id, 'archive_retention_days') into retention_days
  from public.projects where id = p_project_id;
  retention_days := coalesce(retention_days, 10);

  update public.projects set status = 'archived', archived_at = now(), purge_at = now() + make_interval(days => retention_days::integer), updated_at = now()
  where id = p_project_id and status = 'active'
  returning * into result;
  if result.id is null then raise exception 'Only an active project can be archived'; end if;

  update public.project_services set status_before_archive = status, status = 'archived', updated_at = now()
  where project_services.project_id = p_project_id and status <> 'archived';

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (result.account_id, result.id, auth.uid(), 'project.archived', 'project', result.id::text, jsonb_build_object('purge_at', result.purge_at));
  return result;
end;
$$;

create or replace function public.restore_project(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.projects;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  update public.projects set status = 'active', archived_at = null, purge_at = null, updated_at = now()
  where id = p_project_id and status = 'archived' and purge_at > now()
  returning * into result;
  if result.id is null then raise exception 'Project cannot be restored'; end if;

  update public.project_services set status = coalesce(status_before_archive, 'disabled'), status_before_archive = null, updated_at = now()
  where project_services.project_id = p_project_id and status = 'archived';

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (result.account_id, result.id, auth.uid(), 'project.restored', 'project', result.id::text);
  return result;
end;
$$;

create or replace function public.set_project_service_enabled(p_project_id uuid, p_service_slug text, p_enabled boolean)
returns public.project_services
language plpgsql
security definer
set search_path = public
as $$
declare
  service_record public.spaces_services;
  connection public.project_services;
  operation_name text;
begin
  if not public.is_project_owner(p_project_id) then raise exception 'Project owner access required'; end if;
  select * into service_record from public.spaces_services where slug = p_service_slug and status = 'active';
  if service_record.id is null then raise exception 'Service not found'; end if;
  if service_record.is_core and not p_enabled then raise exception 'Core service cannot be disabled'; end if;

  select * into connection from public.project_services
  where public.project_services.project_id = p_project_id and service_id = service_record.id;

  if p_enabled then
    if connection.id is null then
      insert into public.project_services (project_id, service_id, status, external_tenant_name)
      select p_project_id, service_record.id, 'provisioning', name from public.projects where id = p_project_id
      returning * into connection;
      operation_name := 'provision';
    elsif connection.status = 'disabled' then
      update public.project_services set status = 'provisioning', updated_at = now() where id = connection.id returning * into connection;
      operation_name := case when connection.external_tenant_id is null then 'provision' else 'resume' end;
    end if;
  elsif connection.id is not null and connection.status not in ('disabled', 'archived') then
    update public.project_services set status = 'disabled', updated_at = now() where id = connection.id returning * into connection;
    operation_name := 'suspend';
  end if;

  if operation_name is not null then
    insert into public.provisioning_jobs (project_service_id, operation) values (connection.id, operation_name);
  end if;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  select p.account_id, p.id, auth.uid(), case when p_enabled then 'service.enabled' else 'service.disabled' end,
    'service', service_record.id::text, jsonb_build_object('service_slug', p_service_slug)
  from public.projects p where p.id = p_project_id;
  return connection;
end;
$$;

alter table public.accounts enable row level security;
alter table public.account_memberships enable row level security;
alter table public.projects enable row level security;
alter table public.project_memberships enable row level security;
alter table public.project_services enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table public.plans enable row level security;
alter table public.plan_limits enable row level security;
alter table public.account_subscriptions enable row level security;
alter table public.account_limit_overrides enable row level security;
alter table public.harness_templates enable row level security;
alter table public.harness_versions enable row level security;
alter table public.project_harness_settings enable row level security;
alter table public.audit_events enable row level security;
alter table public.mcp_credentials enable row level security;

create policy "Members can read accounts" on public.accounts for select using (public.is_account_member(id));
create policy "Members can read account memberships" on public.account_memberships for select using (public.is_account_member(account_id));
create policy "Members can read projects" on public.projects for select using (public.is_project_member(id));
create policy "Members can read project memberships" on public.project_memberships for select using (public.is_project_member(project_id));
create policy "Members can read project services" on public.project_services for select using (public.is_project_member(project_id));
create policy "Users can read public plans" on public.plans for select using (is_public or public.is_superadmin());
create policy "Users can read plan limits" on public.plan_limits for select using (exists (select 1 from public.plans p where p.id = plan_id and (p.is_public or public.is_superadmin())));
create policy "Members can read subscriptions" on public.account_subscriptions for select using (public.is_account_member(account_id));
create policy "Owners can read account overrides" on public.account_limit_overrides for select using (public.is_account_owner(account_id));
create policy "Members can read project harness settings" on public.project_harness_settings for select using (public.is_project_member(project_id));
create policy "Owners can manage project harness settings" on public.project_harness_settings for all using (public.is_project_owner(project_id)) with check (public.is_project_owner(project_id));
create policy "Users can read published harness templates" on public.harness_templates for select using (status = 'published' or public.is_superadmin());
create policy "Users can read published harness versions" on public.harness_versions for select using (status = 'published' or public.is_superadmin());
create policy "Owners can read project audit" on public.audit_events for select using (project_id is not null and public.is_project_owner(project_id));
create policy "Owners can read MCP credentials" on public.mcp_credentials for select using (public.is_project_owner(project_id));

revoke insert, update, delete on public.accounts, public.account_memberships, public.projects,
  public.project_memberships, public.project_services, public.provisioning_jobs, public.plans,
  public.plan_limits, public.account_subscriptions, public.account_limit_overrides,
  public.harness_templates, public.harness_versions, public.project_harness_settings,
  public.audit_events, public.mcp_credentials
from anon, authenticated;

revoke execute on function public.ensure_personal_account(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.seed_spaces_projects(uuid) from public, anon, authenticated;
revoke execute on function public.protect_platform_roots() from public, anon, authenticated;

revoke execute on function public.create_project(text, text, text, text[]) from public, anon;
revoke execute on function public.update_project(uuid, text, text, text) from public, anon;
revoke execute on function public.archive_project(uuid) from public, anon;
revoke execute on function public.restore_project(uuid) from public, anon;
revoke execute on function public.set_project_service_enabled(uuid, text, boolean) from public, anon;
revoke execute on function public.effective_account_limit(uuid, text) from public, anon;

grant execute on function public.create_project(text, text, text, text[]) to authenticated;
grant execute on function public.update_project(uuid, text, text, text) to authenticated;
grant execute on function public.archive_project(uuid) to authenticated;
grant execute on function public.restore_project(uuid) to authenticated;
grant execute on function public.set_project_service_enabled(uuid, text, boolean) to authenticated;
grant execute on function public.effective_account_limit(uuid, text) to authenticated;

do $$
declare
  superadmin auth.users%rowtype;
  account_id uuid;
begin
  select * into superadmin from auth.users where lower(email) = 'digitalcluster25@gmail.com' limit 1;
  if superadmin.id is not null then
    insert into public.profiles (id, email, display_name, avatar_url, is_superadmin)
    values (
      superadmin.id,
      superadmin.email,
      coalesce(superadmin.raw_user_meta_data->>'name', superadmin.raw_user_meta_data->>'full_name', 'Digital Cluster'),
      superadmin.raw_user_meta_data->>'avatar_url',
      true
    )
    on conflict (id) do update set is_superadmin = true, email = excluded.email, updated_at = now();

    account_id := public.ensure_personal_account(
      superadmin.id,
      superadmin.email,
      coalesce(superadmin.raw_user_meta_data->>'name', superadmin.raw_user_meta_data->>'full_name', 'Digital Cluster')
    );
    perform public.seed_spaces_projects(superadmin.id);
  end if;
end;
$$;

drop trigger if exists protect_superadmin_profile on public.profiles;
create trigger protect_superadmin_profile
  before update or delete on public.profiles
  for each row execute function public.protect_platform_roots();

drop trigger if exists protect_spaces_root_project on public.projects;
create trigger protect_spaces_root_project
  before update or delete on public.projects
  for each row execute function public.protect_platform_roots();

alter table public.profiles
  add constraint profiles_active_project_fk
  foreign key (active_project_id) references public.projects(id) on delete set null;
