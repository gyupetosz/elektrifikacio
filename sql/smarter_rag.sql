-- ============================================================================
-- "Smarter RAG" upgrade for the elektrifikacio schema.
--   1. Hungarian full-text GIN index (for hybrid keyword search)
--   2. match_policy_chunks v2 — now also returns the embedding (for MMR in JS)
--   3. match_policy_chunks_hybrid — Reciprocal-Rank-Fusion of vector + FTS
-- Run once in the aagpkguwghzxdfasoqhn SQL Editor. Idempotent.
-- ============================================================================
set search_path = elektrifikacio, public, extensions;

-- 1) Hungarian full-text index used by the hybrid search
create index if not exists policy_chunks_fts_hu
  on elektrifikacio.policy_chunks
  using gin (to_tsvector('hungarian', content));

-- 2) Vector search, now returning the embedding so JS can run MMR/dedup
drop function if exists elektrifikacio.match_policy_chunks(vector, int, int);
create function elektrifikacio.match_policy_chunks(
  query_embedding vector(1536),
  match_count int,
  min_content_length int default 20
)
returns table(
  id uuid, document_id uuid, chunk_index int, content text,
  embedding vector(1536), similarity float
)
language plpgsql security definer
set search_path = elektrifikacio, public, extensions
as $$
begin
  return query
  select c.id, c.document_id, c.chunk_index, c.content, c.embedding,
         1 - (c.embedding <=> query_embedding) as similarity
  from elektrifikacio.policy_chunks c
  where length(c.content) >= min_content_length
  order by c.embedding <=> query_embedding
  limit match_count;
end; $$;
grant execute on function elektrifikacio.match_policy_chunks(vector, int, int)
  to anon, authenticated, service_role;

-- 3) Hybrid search: RRF over vector-rank and Hungarian keyword-rank
drop function if exists elektrifikacio.match_policy_chunks_hybrid(text, vector, int, int);
create function elektrifikacio.match_policy_chunks_hybrid(
  query_text text,
  query_embedding vector(1536),
  match_count int,
  min_content_length int default 20
)
returns table(
  id uuid, document_id uuid, chunk_index int, content text,
  embedding vector(1536), similarity float
)
language plpgsql security definer
set search_path = elektrifikacio, public, extensions
as $$
declare rrf_k constant int := 60;   -- RRF damping constant
begin
  return query
  with q as (
    select websearch_to_tsquery('hungarian', coalesce(query_text, '')) as tsq
  ),
  vec as (   -- nearest neighbours by embedding
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rnk
    from elektrifikacio.policy_chunks c
    where length(c.content) >= min_content_length
    order by c.embedding <=> query_embedding
    limit 50
  ),
  kw as (    -- best matches by Hungarian full-text rank
    select c.id,
           row_number() over (order by ts_rank(to_tsvector('hungarian', c.content), q.tsq) desc) as rnk
    from elektrifikacio.policy_chunks c, q
    where length(c.content) >= min_content_length
      and q.tsq is not null
      and to_tsvector('hungarian', c.content) @@ q.tsq
    limit 50
  ),
  fused as ( -- reciprocal rank fusion (qualify ids: they collide with OUT cols)
    select u.id, sum(1.0 / (rrf_k + u.rnk)) as score
    from (select vec.id, vec.rnk from vec
          union all
          select kw.id, kw.rnk from kw) u
    group by u.id
  )
  select c.id, c.document_id, c.chunk_index, c.content, c.embedding,
         1 - (c.embedding <=> query_embedding) as similarity
  from fused f
  join elektrifikacio.policy_chunks c on c.id = f.id
  order by f.score desc
  limit match_count;
end; $$;
grant execute on function elektrifikacio.match_policy_chunks_hybrid(text, vector, int, int)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
