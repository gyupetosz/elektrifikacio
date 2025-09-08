-- Enable pgvector
create extension if not exists vector;

-- Tables
create table if not exists public.docs (
  doc_id uuid primary key default gen_random_uuid(),
  source varchar(256),
  locale varchar(8) not null,
  title text,
  url text,
  doc_type varchar(32) not null,    -- 'product' | 'faq' | 'policy' | 'snippet'
  product_id varchar(64),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.chunks (
  chunk_id uuid primary key default gen_random_uuid(),
  doc_id uuid references public.docs(doc_id) on delete cascade,
  product_id varchar(64),
  locale varchar(8) not null,
  doc_type varchar(32) not null,
  section_title text,
  content text not null,
  metadata jsonb default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes
create index if not exists chunks_embedding_idx
  on public.chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists chunks_locale_idx  on public.chunks (locale);
create index if not exists chunks_doctype_idx on public.chunks (doc_type);
create index if not exists chunks_product_idx on public.chunks (product_id);

-- Optional RLS (keep simple for now; service role bypasses RLS)
alter table public.docs   enable row level security;
alter table public.chunks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='chunks' and policyname='read_chunks'
  ) then
    create policy read_chunks on public.chunks for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='docs' and policyname='read_docs'
  ) then
    create policy read_docs on public.docs for select using (true);
  end if;
end $$;

-- RPC for vector search (schema-qualified)
drop function if exists public.match_chunks(vector, int, text, text, text[]);

create or replace function public.match_chunks(
  query_embedding vector(1536),
  match_count int,
  p_locale text,
  p_product_id text,
  p_doctypes text[]
)
returns table(
  chunk_id uuid,
  content text,
  section_title text,
  metadata jsonb,
  score float
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select c.chunk_id, c.content, c.section_title, c.metadata,
         1 - (c.embedding <=> query_embedding) as score
  from public.chunks c
  where c.locale = p_locale
    and (p_product_id is null or c.product_id = p_product_id)
    and (p_doctypes is null or c.doc_type = any (p_doctypes))
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

grant execute on function public.match_chunks(vector, int, text, text, text[]) to anon, authenticated;
