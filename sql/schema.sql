-- Enable pgvector
create extension if not exists vector;

-- Tables
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  path text,
  title text,
  created_at timestamptz default now()
);

create table if not exists public.policy_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  chunk_index int,
  content text not null,
  embedding vector(1536),
  created_at timestamptz default now()
);

-- Index for vector similarity search (add after ingesting data if needed)
-- create index policy_chunks_embedding_idx
--   on public.policy_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- RLS
alter table public.documents    enable row level security;
alter table public.policy_chunks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='policy_chunks' and policyname='read_policy_chunks'
  ) then
    create policy read_policy_chunks on public.policy_chunks for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='documents' and policyname='read_documents'
  ) then
    create policy read_documents on public.documents for select using (true);
  end if;
end $$;

-- RPC for embedding-only vector search
drop function if exists public.match_policy_chunks(vector, int, int);
create or replace function public.match_policy_chunks(
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
set search_path = public
as $$
begin
  return query
  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.policy_chunks c
  where length(c.content) >= min_content_length
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

grant execute on function public.match_policy_chunks(vector, int, int) to anon, authenticated, service_role;
