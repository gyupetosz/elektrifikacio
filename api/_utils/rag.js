// api/_utils/policy_rag.mjs
import OpenAI from 'openai';
import { supabase } from './supabase.js';      // server-side client (service role)
import { embedQuery } from './embeddings.js';  // returns 1536-dim array

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const EMBEDDING_DIM = 1536;
const TOP_K = Math.min(Number(process.env.RAG_TOP_K || 6), 16);
const MIN_LEN = Number(process.env.RAG_MIN_CHUNK_LENGTH || 20);
const MAX_CTX_CHARS = Number(process.env.RAG_MAX_CTX_CHARS || 8000); // kb. 5–6k token

function trimContextBlocks(blocks, maxChars = MAX_CTX_CHARS) {
    const out = [];
    let used = 0;
    for (const b of blocks) {
        // kemény limit blokk-szinten (pl. 1200 char)
        const clipped = b.content.length > 1200 ? b.content.slice(0, 1200) + '…' : b.content;
        if (used + clipped.length > maxChars) break;
        out.push({ ...b, content: clipped });
        used += clipped.length;
    }
    return out;
}

export async function askPolicyRag({ query, k = TOP_K } = {}) {
    if (!query || !query.trim()) {
        return { answer: 'Adj meg egy kérdést.', sources: [] };
    }

    // 1) Embed
    const qvec = await embedQuery(query);
    if (!Array.isArray(qvec) || qvec.length !== EMBEDDING_DIM) {
        throw new Error('Embedding dimension mismatch; check model & SQL schema.');
    }

    // 2) Retrieve via RPC
    let matches = [];
    const { data, error } = await supabase.rpc('match_policy_chunks', {
        query_embedding: qvec,
        match_count: Math.max(1, Math.min(k, 32)),
        min_content_length: MIN_LEN
    });
    if (error) throw error;
    matches = Array.isArray(data) ? data : [];

    if (matches.length === 0) {
        return {
            answer: 'Nem találtam idevágó részletet a tudásbázisban ehhez a kérdéshez.',
            sources: []
        };
    }

    // 3) Context építés (trimmeléssel)
    const trimmed = trimContextBlocks(matches);
    const numbered = trimmed.map((m, i) => `[${i + 1}] ${m.content}`).join('\n\n');

    // 4) Nyelvi / policy-only prompt
    const sys =
        'You are a strict RAG assistant. Answer ONLY from the provided policy/context. If not covered, say you do not have that policy information. Keep answers concise and well-structured.';
    const user =
        `Answer in the language of the question.\n\nCONTEXT:\n${numbered}\n\nQUESTION:\n${query}\n\n` +
        `Reply with inline citations like [1], [2] that correspond to the context blocks above.`;

    const r = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user }
        ],
        temperature: 0.2
    });

    const answer = r.choices?.[0]?.message?.content ?? '';

    return {
        answer,
        // stabil számozás a [1]..[n]-hez
        sources: trimmed.map((m, i) => ({
            index: i + 1,
            id: m.id,
            document_id: m.document_id,
            chunk_index: m.chunk_index,
            similarity: m.similarity
        }))
    };
}
