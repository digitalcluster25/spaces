create extension if not exists vector with schema extensions;

create table if not exists public.project_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  service_slug text not null default 'spaces' check (service_slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  source_type text not null default 'manual' check (source_type in ('manual', 'file', 'service', 'agent', 'outline')),
  source_id text,
  title text not null check (char_length(title) between 1 and 240),
  content text not null check (char_length(content) between 1 and 200000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  embedding extensions.vector(1536),
  embedding_model text,
  search_vector tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_knowledge_project_updated_idx
  on public.project_knowledge_documents (project_id, updated_at desc);
create index if not exists project_knowledge_search_idx
  on public.project_knowledge_documents using gin (search_vector);
create index if not exists project_knowledge_embedding_idx
  on public.project_knowledge_documents using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  service_slug text not null default 'spaces' check (service_slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  bucket_id text not null default 'project-files' check (bucket_id = 'project-files'),
  object_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 240),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'uploading' check (status in ('uploading', 'active', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists project_files_project_status_idx
  on public.project_files (project_id, status, created_at desc);

create table if not exists public.project_secret_metadata (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  kind text not null default 'api_key' check (kind in ('api_key', 'token', 'password', 'credential', 'custom')),
  service_slug text check (service_slug is null or service_slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  description text check (description is null or char_length(description) <= 500),
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  version integer not null default 1 check (version > 0),
  rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists project_secret_active_name_idx
  on public.project_secret_metadata (project_id, name)
  where status <> 'deleted';
create index if not exists project_secret_project_status_idx
  on public.project_secret_metadata (project_id, status, updated_at desc);

create table if not exists public.project_secret_versions (
  id uuid primary key default gen_random_uuid(),
  secret_id uuid not null references public.project_secret_metadata(id) on delete cascade,
  version integer not null check (version > 0),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  algorithm text not null default 'aes-256-gcm' check (algorithm = 'aes-256-gcm'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (secret_id, version)
);

alter table public.project_knowledge_documents enable row level security;
alter table public.project_files enable row level security;
alter table public.project_secret_metadata enable row level security;
alter table public.project_secret_versions enable row level security;

create policy "Project members read knowledge" on public.project_knowledge_documents
  for select using (public.is_project_member(project_id));

create policy "Project members read files" on public.project_files
  for select using (public.is_project_member(project_id));

create policy "Project owners read secret metadata" on public.project_secret_metadata
  for select using (public.is_project_owner(project_id));

revoke all on public.project_secret_versions from public, anon, authenticated;
grant select on public.project_knowledge_documents to authenticated;
grant select on public.project_files to authenticated;
grant select on public.project_secret_metadata to authenticated;
grant select, insert, update, delete on public.project_secret_metadata to service_role;
grant select, insert, update, delete on public.project_secret_versions to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-files',
  'project-files',
  false,
  52428800,
  array[
    'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf',
    'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Project members read private objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
  );
create policy "Project members upload private objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
    and exists (
      select 1 from public.project_files file
      where file.project_id = ((storage.foldername(name))[1])::uuid
        and file.object_path = name
        and file.status = 'uploading'
        and file.created_by = auth.uid()
    )
  );
create policy "Project members remove private objects" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
  );

insert into public.plan_limits (plan_id, key, value, unit, status, description)
select plan.id, setting.key, setting.value, setting.unit, 'active', setting.description
from public.plans plan
join (values
  ('trial', 'file_storage_mb', 100::bigint, 'megabytes', 'Файловое хранилище'),
  ('trial', 'vector_storage_mb', 50::bigint, 'megabytes', 'Векторный контекст'),
  ('trial', 'secrets_per_project', 10::bigint, 'count', 'Секреты проекта'),
  ('trial', 'max_file_mb', 10::bigint, 'megabytes', 'Максимальный размер файла'),
  ('golden', 'file_storage_mb', 5120::bigint, 'megabytes', 'Файловое хранилище'),
  ('golden', 'vector_storage_mb', 2048::bigint, 'megabytes', 'Векторный контекст'),
  ('golden', 'secrets_per_project', 100::bigint, 'count', 'Секреты проекта'),
  ('golden', 'max_file_mb', 50::bigint, 'megabytes', 'Максимальный размер файла'),
  ('corporate', 'file_storage_mb', 20480::bigint, 'megabytes', 'Файловое хранилище'),
  ('corporate', 'vector_storage_mb', 8192::bigint, 'megabytes', 'Векторный контекст'),
  ('corporate', 'secrets_per_project', 500::bigint, 'count', 'Секреты проекта'),
  ('corporate', 'max_file_mb', 50::bigint, 'megabytes', 'Максимальный размер файла'),
  ('internal', 'file_storage_mb', null::bigint, 'megabytes', 'Файловое хранилище'),
  ('internal', 'vector_storage_mb', null::bigint, 'megabytes', 'Векторный контекст'),
  ('internal', 'secrets_per_project', null::bigint, 'count', 'Секреты проекта'),
  ('internal', 'max_file_mb', 50::bigint, 'megabytes', 'Максимальный размер файла')
) as setting(plan_code, key, value, unit, description) on setting.plan_code = plan.code
on conflict (plan_id, key) do update set
  value = excluded.value,
  unit = excluded.unit,
  status = 'active',
  description = excluded.description,
  updated_at = now();

create or replace function public.project_storage_summary(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  account_id_value uuid;
  file_bytes bigint;
  vector_bytes bigint;
  file_limit bigint;
  vector_limit bigint;
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  select account_id into account_id_value from public.projects where id = p_project_id;
  select coalesce(sum(size_bytes), 0) into file_bytes from public.project_files where project_id = p_project_id and status in ('uploading', 'active');
  select coalesce(sum(octet_length(content) + case when embedding is null then 0 else 6144 end), 0)
    into vector_bytes from public.project_knowledge_documents where project_id = p_project_id;
  file_limit := public.effective_account_limit(account_id_value, 'file_storage_mb');
  vector_limit := public.effective_account_limit(account_id_value, 'vector_storage_mb');
  return jsonb_build_object(
    'file_bytes', file_bytes,
    'file_limit_bytes', case when file_limit is null then null else file_limit * 1024 * 1024 end,
    'vector_bytes', vector_bytes,
    'vector_limit_bytes', case when vector_limit is null then null else vector_limit * 1024 * 1024 end,
    'secret_count', (select count(*) from public.project_secret_metadata where project_id = p_project_id and status <> 'deleted'),
    'secret_limit', public.effective_account_limit(account_id_value, 'secrets_per_project')
  );
end;
$$;

create or replace function public.upsert_project_knowledge(
  p_project_id uuid,
  p_id uuid,
  p_title text,
  p_content text,
  p_source_type text default 'manual',
  p_source_id text default null,
  p_service_slug text default 'spaces',
  p_metadata jsonb default '{}'::jsonb,
  p_embedding extensions.vector(1536) default null,
  p_embedding_model text default null
)
returns public.project_knowledge_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_knowledge_documents;
  account_id_value uuid;
  limit_mb bigint;
  current_bytes bigint;
  next_bytes bigint;
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  if nullif(trim(p_title), '') is null or nullif(trim(p_content), '') is null then raise exception 'Title and content are required'; end if;
  if char_length(p_title) > 240 or char_length(p_content) > 200000 then raise exception 'Knowledge document is too large'; end if;
  if p_source_type not in ('manual', 'file', 'service', 'agent', 'outline') then raise exception 'Unsupported source type'; end if;
  if p_service_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' then raise exception 'Invalid service slug'; end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then raise exception 'Metadata must be an object'; end if;
  select account_id into account_id_value from public.projects where id = p_project_id and status = 'active';
  if account_id_value is null then raise exception 'Project must be active'; end if;
  limit_mb := public.effective_account_limit(account_id_value, 'vector_storage_mb');
  select coalesce(sum(octet_length(content) + case when embedding is null then 0 else 6144 end), 0)
    into current_bytes from public.project_knowledge_documents where project_id = p_project_id and (p_id is null or id <> p_id);
  next_bytes := octet_length(p_content) + case when p_embedding is null then 0 else 6144 end;
  if limit_mb is not null and current_bytes + next_bytes > limit_mb * 1024 * 1024 then raise exception 'Vector storage limit reached'; end if;

  if p_id is null then
    insert into public.project_knowledge_documents (
      project_id, created_by, service_slug, source_type, source_id, title, content, metadata, embedding, embedding_model
    ) values (
      p_project_id, auth.uid(), p_service_slug, p_source_type, nullif(trim(p_source_id), ''), trim(p_title), trim(p_content), coalesce(p_metadata, '{}'::jsonb), p_embedding, nullif(trim(p_embedding_model), '')
    ) returning * into result;
  else
    update public.project_knowledge_documents set
      service_slug = p_service_slug,
      source_type = p_source_type,
      source_id = nullif(trim(p_source_id), ''),
      title = trim(p_title),
      content = trim(p_content),
      metadata = coalesce(p_metadata, '{}'::jsonb),
      embedding = p_embedding,
      embedding_model = nullif(trim(p_embedding_model), ''),
      updated_at = now()
    where id = p_id and project_id = p_project_id
    returning * into result;
    if result.id is null then raise exception 'Knowledge document not found'; end if;
  end if;

  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, p_project_id, auth.uid(), 'storage.knowledge.saved', 'knowledge_document', result.id::text,
    jsonb_build_object('service', result.service_slug, 'source_type', result.source_type, 'has_embedding', result.embedding is not null));
  return result;
end;
$$;

create or replace function public.search_project_knowledge(
  p_project_id uuid,
  p_query text default '',
  p_embedding extensions.vector(1536) default null,
  p_limit integer default 10
)
returns table (
  id uuid,
  title text,
  content text,
  service_slug text,
  source_type text,
  source_id text,
  metadata jsonb,
  embedding_model text,
  score double precision,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  if p_embedding is null and nullif(trim(p_query), '') is null then raise exception 'Query or embedding is required'; end if;
  return query
  select document.id, document.title, document.content, document.service_slug, document.source_type,
    document.source_id, document.metadata, document.embedding_model,
    greatest(
      case when p_embedding is null or document.embedding is null then 0 else 1 - (document.embedding operator(extensions.<=>) p_embedding) end,
      case when nullif(trim(p_query), '') is null then 0 else ts_rank_cd(document.search_vector, websearch_to_tsquery('simple', p_query)) end
    )::double precision as score,
    document.updated_at
  from public.project_knowledge_documents document
  where document.project_id = p_project_id
    and (
      (p_embedding is not null and document.embedding is not null)
      or (nullif(trim(p_query), '') is not null and document.search_vector @@ websearch_to_tsquery('simple', p_query))
    )
  order by score desc, document.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
end;
$$;

create or replace function public.delete_project_knowledge(p_project_id uuid, p_document_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  account_id_value uuid;
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  select account_id into account_id_value from public.projects where id = p_project_id;
  delete from public.project_knowledge_documents where id = p_document_id and project_id = p_project_id;
  if not found then raise exception 'Knowledge document not found'; end if;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (account_id_value, p_project_id, auth.uid(), 'storage.knowledge.deleted', 'knowledge_document', p_document_id::text);
end;
$$;

create or replace function public.reserve_project_file(
  p_project_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_service_slug text default 'spaces'
)
returns public.project_files
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_files;
  account_id_value uuid;
  limit_mb bigint;
  max_file_mb bigint;
  used_bytes bigint;
  allowed_mime_types constant text[] := array[
    'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf',
    'image/png', 'image/jpeg', 'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];
begin
  if not public.is_project_member(p_project_id) then raise exception 'Project member access required'; end if;
  if nullif(trim(p_file_name), '') is null or char_length(p_file_name) > 240 then raise exception 'Invalid file name'; end if;
  if p_mime_type <> all(allowed_mime_types) then raise exception 'Unsupported file type'; end if;
  if p_size_bytes <= 0 then raise exception 'File is empty'; end if;
  select account_id into account_id_value from public.projects where id = p_project_id and status = 'active';
  if account_id_value is null then raise exception 'Project must be active'; end if;
  limit_mb := public.effective_account_limit(account_id_value, 'file_storage_mb');
  max_file_mb := public.effective_account_limit(account_id_value, 'max_file_mb');
  if max_file_mb is not null and p_size_bytes > max_file_mb * 1024 * 1024 then raise exception 'File is larger than the plan allows'; end if;
  select coalesce(sum(size_bytes), 0) into used_bytes from public.project_files
    where project_id = p_project_id and status in ('uploading', 'active');
  if limit_mb is not null and used_bytes + p_size_bytes > limit_mb * 1024 * 1024 then raise exception 'File storage limit reached'; end if;
  insert into public.project_files (project_id, created_by, service_slug, object_path, file_name, mime_type, size_bytes)
  values (
    p_project_id,
    auth.uid(),
    p_service_slug,
    p_project_id::text || '/' || gen_random_uuid()::text || '/' || regexp_replace(trim(p_file_name), '[^[:alnum:]._-]+', '_', 'g'),
    trim(p_file_name),
    p_mime_type,
    p_size_bytes
  ) returning * into result;
  return result;
end;
$$;

create or replace function public.complete_project_file(p_file_id uuid, p_sha256 text default null)
returns public.project_files
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_files;
  account_id_value uuid;
begin
  select file.project_id, project.account_id into result.project_id, account_id_value
  from public.project_files file join public.projects project on project.id = file.project_id
  where file.id = p_file_id;
  if result.project_id is null or not public.is_project_member(result.project_id) then raise exception 'Project member access required'; end if;
  if p_sha256 is not null and p_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'Invalid SHA-256'; end if;
  update public.project_files set status = 'active', sha256 = p_sha256, updated_at = now()
  where id = p_file_id and status = 'uploading' returning * into result;
  if result.id is null then raise exception 'File reservation not found'; end if;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, result.project_id, auth.uid(), 'storage.file.uploaded', 'project_file', result.id::text,
    jsonb_build_object('mime_type', result.mime_type, 'size_bytes', result.size_bytes, 'service', result.service_slug));
  return result;
end;
$$;

create or replace function public.cancel_project_file(p_file_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_files;
begin
  select * into result from public.project_files where id = p_file_id and status = 'uploading';
  if result.id is null or not public.is_project_member(result.project_id) then raise exception 'Project member access required'; end if;
  update public.project_files set status = 'deleted', deleted_at = now(), updated_at = now() where id = p_file_id;
  return result.object_path;
end;
$$;

create or replace function public.delete_project_file(p_file_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_files;
  account_id_value uuid;
begin
  select * into result from public.project_files where id = p_file_id;
  if result.id is null or not public.is_project_member(result.project_id) then raise exception 'Project member access required'; end if;
  select account_id into account_id_value from public.projects where id = result.project_id;
  update public.project_files set status = 'deleted', deleted_at = now(), updated_at = now() where id = p_file_id;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id)
  values (account_id_value, result.project_id, auth.uid(), 'storage.file.deleted', 'project_file', result.id::text);
  return result.object_path;
end;
$$;

create or replace function public.store_project_secret_ciphertext(
  p_project_id uuid,
  p_secret_id uuid,
  p_name text,
  p_kind text,
  p_service_slug text,
  p_description text,
  p_ciphertext text,
  p_iv text,
  p_auth_tag text,
  p_actor_id uuid
)
returns public.project_secret_metadata
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_secret_metadata;
  account_id_value uuid;
  secret_limit bigint;
  active_count bigint;
  next_version integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if not public.is_project_owner(p_project_id, p_actor_id) then raise exception 'Project owner access required'; end if;
  if p_name !~ '^[A-Z][A-Z0-9_]{1,79}$' then raise exception 'Invalid secret name'; end if;
  if p_kind not in ('api_key', 'token', 'password', 'credential', 'custom') then raise exception 'Unsupported secret kind'; end if;
  if p_service_slug is not null and p_service_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' then raise exception 'Invalid service slug'; end if;
  if length(p_ciphertext) < 2 or length(p_iv) < 2 or length(p_auth_tag) < 2 then raise exception 'Invalid encrypted payload'; end if;
  select account_id into account_id_value from public.projects where id = p_project_id and status = 'active';
  if account_id_value is null then raise exception 'Project must be active'; end if;

  if p_secret_id is null then
    secret_limit := public.effective_account_limit(account_id_value, 'secrets_per_project');
    select count(*) into active_count from public.project_secret_metadata where project_id = p_project_id and status <> 'deleted';
    if secret_limit is not null and active_count >= secret_limit then raise exception 'Secret limit reached'; end if;
    insert into public.project_secret_metadata (project_id, created_by, updated_by, name, kind, service_slug, description)
    values (p_project_id, p_actor_id, p_actor_id, p_name, p_kind, nullif(p_service_slug, ''), nullif(trim(p_description), ''))
    returning * into result;
  else
    select * into result from public.project_secret_metadata
    where id = p_secret_id and project_id = p_project_id and status <> 'deleted' for update;
    if result.id is null then raise exception 'Secret not found'; end if;
    next_version := result.version + 1;
    update public.project_secret_metadata set
      name = p_name,
      kind = p_kind,
      service_slug = nullif(p_service_slug, ''),
      description = nullif(trim(p_description), ''),
      status = 'active',
      version = next_version,
      rotated_at = now(),
      updated_by = p_actor_id,
      updated_at = now()
    where id = result.id returning * into result;
  end if;
  insert into public.project_secret_versions (secret_id, version, ciphertext, iv, auth_tag, created_by)
  values (result.id, result.version, p_ciphertext, p_iv, p_auth_tag, p_actor_id);
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, p_project_id, p_actor_id,
    case when result.version = 1 then 'storage.secret.created' else 'storage.secret.rotated' end,
    'project_secret', result.id::text,
    jsonb_build_object('name', result.name, 'kind', result.kind, 'service', result.service_slug, 'version', result.version));
  return result;
end;
$$;

create or replace function public.set_project_secret_status(
  p_secret_id uuid,
  p_status text,
  p_actor_id uuid
)
returns public.project_secret_metadata
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_secret_metadata;
  account_id_value uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_status not in ('active', 'disabled', 'deleted') then raise exception 'Unsupported status'; end if;
  select * into result from public.project_secret_metadata where id = p_secret_id and status <> 'deleted' for update;
  if result.id is null or not public.is_project_owner(result.project_id, p_actor_id) then raise exception 'Project owner access required'; end if;
  select account_id into account_id_value from public.projects where id = result.project_id;
  update public.project_secret_metadata set
    status = p_status,
    deleted_at = case when p_status = 'deleted' then now() else null end,
    updated_by = p_actor_id,
    updated_at = now()
  where id = p_secret_id returning * into result;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, result.project_id, p_actor_id, 'storage.secret.status_changed', 'project_secret', result.id::text,
    jsonb_build_object('name', result.name, 'status', result.status));
  return result;
end;
$$;

create or replace function public.record_project_secret_access(
  p_secret_id uuid,
  p_consumer text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  secret record;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if nullif(trim(p_consumer), '') is null or length(p_consumer) > 120 then raise exception 'Invalid consumer'; end if;
  select metadata.id, metadata.project_id, metadata.name, project.account_id
    into secret
  from public.project_secret_metadata metadata
  join public.projects project on project.id = metadata.project_id
  where metadata.id = p_secret_id and metadata.status = 'active';
  if secret.id is null then raise exception 'Secret unavailable'; end if;
  insert into public.audit_events (account_id, project_id, action, target_type, target_id, metadata)
  values (secret.account_id, secret.project_id, 'storage.secret.accessed', 'project_secret', secret.id::text,
    jsonb_build_object('name', secret.name, 'consumer', trim(p_consumer)));
end;
$$;

create or replace function public.mcp_upsert_project_knowledge(
  p_credential_id uuid,
  p_document_id uuid,
  p_title text,
  p_content text,
  p_source_type text,
  p_source_id text,
  p_service_slug text,
  p_metadata jsonb,
  p_embedding extensions.vector(1536),
  p_embedding_model text,
  p_gateway_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  credential record;
  result public.project_knowledge_documents;
begin
  select key.project_id, key.created_by into credential
  from public.mcp_credentials key
  join public.spaces_services service on service.slug = 'spaces'
  join public.service_auth_secrets secret on secret.service_id = service.id
  where key.id = p_credential_id
    and key.revoked_at is null
    and (key.expires_at is null or key.expires_at > now())
    and 'knowledge:write' = any(key.scopes)
    and secret.token_hash = extensions.digest(coalesce(p_gateway_secret, ''), 'sha256');
  if credential.project_id is null then raise exception 'Knowledge write access denied'; end if;
  perform set_config('request.jwt.claim.sub', credential.created_by::text, true);
  result := public.upsert_project_knowledge(credential.project_id, p_document_id, p_title, p_content,
    coalesce(p_source_type, 'agent'), p_source_id, coalesce(p_service_slug, 'spaces'), coalesce(p_metadata, '{}'::jsonb), p_embedding, p_embedding_model);
  return to_jsonb(result) - 'embedding' - 'search_vector';
end;
$$;

create or replace function public.mcp_search_project_knowledge(
  p_credential_id uuid,
  p_query text,
  p_embedding extensions.vector(1536),
  p_limit integer,
  p_gateway_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  project_id_value uuid;
  actor_id_value uuid;
begin
  select key.project_id, key.created_by into project_id_value, actor_id_value
  from public.mcp_credentials key
  join public.spaces_services service on service.slug = 'spaces'
  join public.service_auth_secrets secret on secret.service_id = service.id
  where key.id = p_credential_id
    and key.revoked_at is null
    and (key.expires_at is null or key.expires_at > now())
    and ('knowledge:read' = any(key.scopes) or 'knowledge:write' = any(key.scopes))
    and secret.token_hash = extensions.digest(coalesce(p_gateway_secret, ''), 'sha256');
  if project_id_value is null then raise exception 'Knowledge read access denied'; end if;
  perform set_config('request.jwt.claim.sub', actor_id_value::text, true);
  return coalesce((select jsonb_agg(to_jsonb(match)) from public.search_project_knowledge(project_id_value, p_query, p_embedding, p_limit) match), '[]'::jsonb);
end;
$$;

revoke execute on function public.store_project_secret_ciphertext(uuid, uuid, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.set_project_secret_status(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.record_project_secret_access(uuid, text) from public, anon, authenticated;
revoke execute on function public.project_storage_summary(uuid) from public, anon;
revoke execute on function public.upsert_project_knowledge(uuid, uuid, text, text, text, text, text, jsonb, extensions.vector, text) from public, anon;
revoke execute on function public.search_project_knowledge(uuid, text, extensions.vector, integer) from public, anon;
revoke execute on function public.delete_project_knowledge(uuid, uuid) from public, anon;
revoke execute on function public.reserve_project_file(uuid, text, text, bigint, text) from public, anon;
revoke execute on function public.complete_project_file(uuid, text) from public, anon;
revoke execute on function public.cancel_project_file(uuid) from public, anon;
revoke execute on function public.delete_project_file(uuid) from public, anon;
revoke execute on function public.mcp_upsert_project_knowledge(uuid, uuid, text, text, text, text, text, jsonb, extensions.vector, text, text) from public;
revoke execute on function public.mcp_search_project_knowledge(uuid, text, extensions.vector, integer, text) from public;
grant execute on function public.project_storage_summary(uuid) to authenticated;
grant execute on function public.upsert_project_knowledge(uuid, uuid, text, text, text, text, text, jsonb, extensions.vector, text) to authenticated;
grant execute on function public.search_project_knowledge(uuid, text, extensions.vector, integer) to authenticated;
grant execute on function public.delete_project_knowledge(uuid, uuid) to authenticated;
grant execute on function public.reserve_project_file(uuid, text, text, bigint, text) to authenticated;
grant execute on function public.complete_project_file(uuid, text) to authenticated;
grant execute on function public.cancel_project_file(uuid) to authenticated;
grant execute on function public.delete_project_file(uuid) to authenticated;
grant execute on function public.store_project_secret_ciphertext(uuid, uuid, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.set_project_secret_status(uuid, text, uuid) to service_role;
grant execute on function public.record_project_secret_access(uuid, text) to service_role;
grant execute on function public.mcp_upsert_project_knowledge(uuid, uuid, text, text, text, text, text, jsonb, extensions.vector, text, text) to anon, authenticated;
grant execute on function public.mcp_search_project_knowledge(uuid, text, extensions.vector, integer, text) to anon, authenticated;

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
  select account_id into account_id_value from public.projects where id = p_project_id and status = 'active' for update;
  if account_id_value is null then raise exception 'Project must be active'; end if;
  if coalesce(array_length(p_scopes, 1), 0) = 0
    or exists (select 1 from unnest(p_scopes) scope where scope not in ('memory:read', 'memory:write', 'knowledge:read', 'knowledge:write', 'openseo:*'))
    or ('memory:write' = any(p_scopes) and not 'memory:read' = any(p_scopes))
    or ('knowledge:write' = any(p_scopes) and not 'knowledge:read' = any(p_scopes)) then
    raise exception 'Unsupported MCP scope';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'Expiration must be in the future'; end if;
  key_limit := public.effective_account_limit(account_id_value, 'mcp_keys_per_project');
  select count(*) into active_count from public.mcp_credentials
    where project_id = p_project_id and revoked_at is null and (expires_at is null or expires_at > now());
  if key_limit is not null and active_count >= key_limit then raise exception 'MCP credential limit reached'; end if;
  raw_token := 'spc_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.mcp_credentials (project_id, created_by, name, token_hash, scopes, expires_at)
  values (p_project_id, auth.uid(), trim(p_name), encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    array(select distinct scope from unnest(p_scopes) scope order by scope), p_expires_at)
  returning * into created;
  insert into public.audit_events (account_id, project_id, actor_id, action, target_type, target_id, metadata)
  values (account_id_value, p_project_id, auth.uid(), 'mcp.credential.created', 'mcp_credential', created.id::text,
    jsonb_build_object('scopes', created.scopes, 'expires_at', created.expires_at));
  return jsonb_build_object('id', created.id, 'name', created.name, 'token', raw_token, 'scopes', created.scopes, 'expires_at', created.expires_at, 'created_at', created.created_at);
end;
$$;
