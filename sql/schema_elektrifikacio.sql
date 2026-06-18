-- ============================================================================
-- elektrifikacio KB, isolated in its own Postgres schema so it can live inside
-- the shared VitaminBottle project (aagpkguwghzxdfasoqhn) WITHOUT colliding with
-- VitaminBottle's own public.documents table.
--
-- Run this once in the new project's SQL Editor. Idempotent (safe to re-run).
-- After running, add `elektrifikacio` to Settings → API → Exposed schemas.
-- ============================================================================

-- pgvector (no-op if already enabled by VitaminBottle). The SQL editor's
-- search_path resolves the `vector` type regardless of which schema it lives in.
create extension if not exists vector;

-- Dedicated, isolated schema
create schema if not exists elektrifikacio;

-- Let the PostgREST roles see into the schema
grant usage on schema elektrifikacio to anon, authenticated, service_role;

-- Tables -------------------------------------------------------------------
create table if not exists elektrifikacio.documents (
  id uuid primary key default gen_random_uuid(),
  path text,
  title text,
  created_at timestamptz default now()
);

create table if not exists elektrifikacio.policy_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references elektrifikacio.documents(id) on delete cascade,
  chunk_index int,
  content text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

-- Grants on tables
grant select on elektrifikacio.documents     to anon, authenticated;
grant select on elektrifikacio.policy_chunks  to anon, authenticated;
grant all    on elektrifikacio.documents      to service_role;
grant all    on elektrifikacio.policy_chunks   to service_role;

-- RLS (service role used by the API bypasses RLS; anon gets read-only)
alter table elektrifikacio.documents     enable row level security;
alter table elektrifikacio.policy_chunks  enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='elektrifikacio' and tablename='documents' and policyname='read_documents') then
    create policy read_documents on elektrifikacio.documents for select using (true);
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='elektrifikacio' and tablename='policy_chunks' and policyname='read_policy_chunks') then
    create policy read_policy_chunks on elektrifikacio.policy_chunks for select using (true);
  end if;
end $$;

-- Vector search RPC (embedding-only). search_path includes public+extensions so
-- the `<=>` operator / vector type resolve no matter where pgvector is installed.
create or replace function elektrifikacio.match_policy_chunks(
  query_embedding vector(1536),
  match_count int,
  min_content_length int default 20
)
returns table(
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  similarity float
)
language plpgsql
security definer
set search_path = elektrifikacio, public, extensions
as $$
begin
  return query
  select c.id, c.document_id, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from elektrifikacio.policy_chunks c
  where length(c.content) >= min_content_length
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

grant execute on function elektrifikacio.match_policy_chunks(vector, int, int)
  to anon, authenticated, service_role;

-- Ask PostgREST to pick up the new schema immediately
notify pgrst, 'reload schema';
