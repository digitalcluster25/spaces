-- SPC-0018: read-only access of the restricted agent runner to the published
-- project Harness. The runner holds a secret; only its sha256 is stored here.
-- The RPC returns nothing but the active effective Harness of the bound project.
create table if not exists public.agent_runner_credentials (
  project_id uuid primary key references public.projects(id) on delete cascade,
  token_hash bytea not null,
  rotated_at timestamptz not null default now()
);

alter table public.agent_runner_credentials enable row level security;
revoke all on public.agent_runner_credentials from public, anon, authenticated;

-- Only where the Spaces project exists (production); fresh/staging databases skip it.
insert into public.agent_runner_credentials (project_id, token_hash)
select p.id, decode('22d41756890c07375be930e9ba9aac7c1a4cb884d0e02ec8afe91bc69834ee42', 'hex')
from public.projects p
where p.id = 'f1857726-60e0-42ee-afd0-67b893f1ef6d'
on conflict (project_id) do update set token_hash = excluded.token_hash, rotated_at = now();

create or replace function public.get_agent_harness(p_project_id uuid, p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not exists (
    select 1 from public.agent_runner_credentials c
    where c.project_id = p_project_id
      and c.token_hash = extensions.digest(coalesce(p_secret, ''), 'sha256')
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'sequence', v.sequence,
    'created_at', v.created_at,
    'effective_config', v.effective_config
  ) into result
  from public.project_harness_settings s
  join public.project_harness_versions v on v.id = s.active_user_version_id
  where s.project_id = p_project_id;

  if result is null then raise exception 'Harness is not published'; end if;
  return result;
end;
$$;

revoke execute on function public.get_agent_harness(uuid, text) from public, authenticated;
grant execute on function public.get_agent_harness(uuid, text) to anon;
