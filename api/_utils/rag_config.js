export const RAG_CONFIG = {
    CHAT_MODEL: 'gpt-4o-mini',
    EMBEDDING_MODEL: 'text-embedding-3-small',
    RAG_TOP_K: 10,  // More context documents
    RAG_MIN_CHUNK_LENGTH: 20,
    RAG_MAX_CTX_CHARS: 8000,
    RAG_USE_HYBRID: false,   // ha Vercelben nincs be�ll�tva, ez lesz az alap
    STRIP_CITATIONS: false,
    RAG_DEBUG: false
};