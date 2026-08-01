create extension if not exists vector with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.spaces_services (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  subdomain text not null unique,
  description text,
  status text not null default 'planned' check (status in ('planned', 'active', 'paused')),
  created_at timestamptz not null default now()
);

create table if not exists public.service_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service_id uuid not null references public.spaces_services(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (user_id, service_id)
);

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  service_id uuid references public.spaces_services(id) on delete cascade,
  title text not null,
  body text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.spaces_services enable row level security;
alter table public.service_memberships enable row level security;
alter table public.knowledge_documents enable row level security;

create policy "Users can read their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "Users can read active services"
  on public.spaces_services for select
  using (status = 'active' or exists (
    select 1
    from public.service_memberships sm
    where sm.service_id = spaces_services.id
      and sm.user_id = auth.uid()
  ));

create policy "Users can read their memberships"
  on public.service_memberships for select
  using (auth.uid() = user_id);

create policy "Users can read their knowledge documents"
  on public.knowledge_documents for select
  using (auth.uid() = owner_id);

create policy "Users can insert their knowledge documents"
  on public.knowledge_documents for insert
  with check (auth.uid() = owner_id);

create policy "Users can update their knowledge documents"
  on public.knowledge_documents for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
