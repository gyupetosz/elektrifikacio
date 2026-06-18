export const RAG_CONFIG = {
    CHAT_MODEL: 'gpt-4o-mini',
    EMBEDDING_MODEL: 'text-embedding-3-small',

    RAG_TOP_K: 8,             // final chunks sent to the LLM
    RAG_FETCH_K: 24,          // candidate pool pulled from retrieval (before rerank/MMR)
    RAG_MIN_CHUNK_LENGTH: 20,
    RAG_MAX_CTX_CHARS: 8000,

    // Smarter-retrieval switches
    RAG_USE_HYBRID: true,     // keyword + vector (RRF) via match_policy_chunks_hybrid
    RAG_USE_DEDUP: true,      // drop near-duplicate chunks
    RAG_DEDUP_SIM: 0.96,      // cosine >= this => duplicate
    RAG_USE_RERANK: true,     // LLM relevance rerank of the candidate pool
    RAG_USE_MMR: true,        // diversify final selection
    RAG_MMR_LAMBDA: 0.7,      // 1 = pure relevance, 0 = pure diversity
    RAG_CONDENSE_HISTORY: true, // rewrite follow-ups into standalone questions

    STRIP_CITATIONS: false,
    RAG_DEBUG: false,
};
