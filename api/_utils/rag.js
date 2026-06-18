// Smarter RAG pipeline for the Elektrifikációs Asszisztens:
//   condense follow-up -> embed -> hybrid retrieve -> dedup -> LLM rerank ->
//   MMR diversify -> answer.
// Each stage is config-gated (rag_config.js) and overridable per-call via `cfg`
// so the A/B harness can compare baseline vs. improved on the same questions.
// Degrades gracefully: if smarter_rag.sql hasn't been applied (no hybrid RPC /
// no returned embeddings), it falls back to embedding-only retrieval and skips
// the embedding-based steps.
import OpenAI from 'openai';
import { supabase } from './supabase.js';
import { embedQuery, EMBEDDING_DIM } from './embeddings.js';
import { RAG_CONFIG } from './rag_config.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── small vector helpers ────────────────────────────────────────────────────
function parseEmbedding(e) {
    if (!e) return null;
    if (Array.isArray(e)) return e;
    if (typeof e === 'string') { try { return JSON.parse(e); } catch { return null; } }
    return null;
}
function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── system prompt (unchanged voice) ─────────────────────────────────────────
function systemPromptHu() {
    return `
Te egy szigorú RAG-alapú „Elektrifikációs Asszisztens" vagy.

SZEREP ÉS HATÓKÖR
- Elsődlegesen a megadott KONTEXTUS alapján válaszolj.
- Ha a kérdésre nincs szó szerinti válasz, de a KONTEXTUS tartalmaz tartalmilag egyenértékű állítást vagy definíciót, add meg azt a választ.
- Ne jelezd külön, ha valami nincs a kontextusban. Csak a legjobb tudásod szerint válaszolj.

NYELV
- A felhasználó nyelvén válaszolj; ha a kérdés magyar, magyarul válaszolj. Ha a kontextus nem magyar, fogalmazd át magyarul.

STÍLUS
- Légy tömör, egyértelmű és jól tagolt.
- Eljárásoknál/képleteknél használj számozott lépéseket (1), 2), 3) …).
- TILOS LaTeX formátumot használni ([ ] vagy $$ $$). Egyszerű szöveges formában írd a számításokat és képleteket.

KORLÁTOK
- Ha több lehetséges értelmezés van, jelezd a feltételezéseidet röviden.
- Ne mondj ellent a KONTEXTUSNAK. Kétség esetén inkább légy óvatos, és javasolj pontosítást.
- Ha nincs EGYÁLTALÁN releváns információ, kérj pontosítást a kérdés tisztázására.
- Ne térj vissza [..] hivatkozásokkal.

KIMENET
- Csak a választ add vissza. Ne csatolj nyers JSON-t, táblákat vagy metaadatokat vagy hivatkozásokat.
  `.trim();
}

// ── stage: condense a follow-up into a standalone question ───────────────────
async function condenseQuery(history, query, model) {
    const turns = (history || [])
        .filter(m => m && typeof m.content === 'string' && m.content.trim())
        .slice(-6)
        .map(m => `${m.role === 'assistant' ? 'Asszisztens' : 'Felhasználó'}: ${m.content.trim()}`)
        .join('\n');
    if (!turns) return query;
    try {
        const r = await openai.chat.completions.create({
            model,
            temperature: 0,
            messages: [
                { role: 'system', content: 'Fogalmazd át a felhasználó utolsó kérdését ÖNÁLLÓ, magyar kérdéssé a beszélgetés alapján (oldd fel a "ez", "az", "és akkor" típusú visszautalásokat). CSAK az átfogalmazott kérdést add vissza, semmi mást.' },
                { role: 'user', content: `BESZÉLGETÉS:\n${turns}\n\nUTOLSÓ KÉRDÉS:\n${query}\n\nÖnálló kérdés:` },
            ],
        });
        const out = r.choices?.[0]?.message?.content?.trim();
        return out || query;
    } catch { return query; }
}

// ── stage: retrieve candidate pool (hybrid w/ fallback to embedding-only) ─────
async function retrieve(C, qvec, queryText, fetchK) {
    const matchCount = Math.max(1, Math.min(fetchK, 48));
    if (C.RAG_USE_HYBRID) {
        const { data, error } = await supabase.rpc('match_policy_chunks_hybrid', {
            query_text: queryText,
            query_embedding: qvec,
            match_count: matchCount,
            min_content_length: Number(C.RAG_MIN_CHUNK_LENGTH),
        });
        if (!error && Array.isArray(data)) return { data, mode: 'hybrid' };
        // hybrid RPC missing/erroring -> fall back to embedding-only
    }
    const { data, error } = await supabase.rpc('match_policy_chunks', {
        query_embedding: qvec,
        match_count: matchCount,
        min_content_length: Number(C.RAG_MIN_CHUNK_LENGTH),
    });
    if (error) throw new Error(`RAG RPC failed: ${error.message} (code=${error.code})`);
    return { data: Array.isArray(data) ? data : [], mode: 'embedding' };
}

// ── stage: drop near-duplicate chunks ────────────────────────────────────────
function dedup(items, simThreshold) {
    const kept = [];
    for (const it of items) {
        let dupe = false;
        for (const k of kept) {
            if (it.embedding && k.embedding) {
                if (cosine(it.embedding, k.embedding) >= simThreshold) { dupe = true; break; }
            } else {
                // no embeddings -> normalized-content fallback
                const a = it.content.replace(/\s+/g, ' ').trim().slice(0, 160);
                const b = k.content.replace(/\s+/g, ' ').trim().slice(0, 160);
                if (a && a === b) { dupe = true; break; }
            }
        }
        if (!dupe) kept.push(it);
    }
    return kept;
}

// ── stage: LLM listwise rerank -> returns items in relevance order ───────────
async function llmRerank(query, items, model) {
    if (items.length <= 1) return items;
    const numbered = items.map((m, i) => `[${i}] ${m.content.replace(/\s+/g, ' ').slice(0, 350)}`).join('\n');
    try {
        const r = await openai.chat.completions.create({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: 'Rangsorold a szövegrészleteket a kérdéshez való relevancia szerint (legrelevánsabb elöl). Válaszolj JSON-nal: {"order": [indexek a legrelevánstól a legkevésbé relevánsig]}. Csak a megadott indexeket használd.' },
                { role: 'user', content: `KÉRDÉS: ${query}\n\nRÉSZLETEK:\n${numbered}` },
            ],
        });
        const parsed = JSON.parse(r.choices?.[0]?.message?.content || '{}');
        const order = Array.isArray(parsed.order) ? parsed.order : [];
        const seen = new Set();
        const ranked = [];
        for (const idx of order) {
            if (Number.isInteger(idx) && idx >= 0 && idx < items.length && !seen.has(idx)) {
                seen.add(idx); ranked.push(items[idx]);
            }
        }
        // append any the model dropped, preserving original order
        items.forEach((it, i) => { if (!seen.has(i)) ranked.push(it); });
        return ranked;
    } catch { return items; }
}

// ── stage: MMR diversify selection ───────────────────────────────────────────
function mmrSelect(items, k, lambda) {
    if (!items.every(it => it.embedding)) return items.slice(0, k); // need embeddings
    const pool = items.slice();
    const selected = [];
    while (selected.length < k && pool.length) {
        let best = -Infinity, bestIdx = 0;
        for (let i = 0; i < pool.length; i++) {
            let maxSim = 0;
            for (const s of selected) maxSim = Math.max(maxSim, cosine(pool[i].embedding, s.embedding));
            const score = lambda * pool[i].rel - (1 - lambda) * maxSim;
            if (score > best) { best = score; bestIdx = i; }
        }
        selected.push(pool.splice(bestIdx, 1)[0]);
    }
    return selected;
}

function trimContextBlocks(blocks, maxChars) {
    const out = []; let used = 0;
    for (const b of blocks) {
        const clipped = b.content.length > 900 ? b.content.slice(0, 900) + '…' : b.content;
        if (used + clipped.length > maxChars) break;
        out.push({ ...b, content: clipped }); used += clipped.length;
    }
    return out;
}

// ── main entry point ─────────────────────────────────────────────────────────
export async function askPolicyRag({ query, history = [], k, cfg = {} } = {}) {
    const C = { ...RAG_CONFIG, ...cfg };
    const TOP_K = k || Number(C.RAG_TOP_K);
    if (!query || !query.trim()) return { answer: 'Adj meg egy kérdést.', sources: [] };

    const dbg = { stages: {} };

    // 1) condense follow-up
    const standalone = (C.RAG_CONDENSE_HISTORY && history.length)
        ? await condenseQuery(history, query, C.CHAT_MODEL)
        : query;
    dbg.standalone = standalone;

    // 2) embed
    let qvec;
    try { qvec = await embedQuery(standalone); }
    catch (e) { e.step = 'embed'; throw e; }
    if (!Array.isArray(qvec) || qvec.length !== EMBEDDING_DIM) {
        throw new Error(`Embedding dimension mismatch (got ${qvec?.length}, want ${EMBEDDING_DIM}).`);
    }

    // 3) retrieve candidate pool
    const ret = await retrieve(C, qvec, standalone, Number(C.RAG_FETCH_K));
    let pool = ret.data.map(m => ({ ...m, embedding: parseEmbedding(m.embedding) }));
    dbg.mode = ret.mode;
    dbg.stages.retrieved = pool.length;
    dbg.stages.withEmbeddings = pool.filter(p => p.embedding).length;
    if (pool.length === 0) {
        return { answer: 'Nem találtam idevágó részletet a tudásbázisban ehhez a kérdéshez.', sources: [], debug: C.RAG_DEBUG ? dbg : undefined };
    }

    // 4) dedup
    if (C.RAG_USE_DEDUP) { pool = dedup(pool, Number(C.RAG_DEDUP_SIM)); dbg.stages.afterDedup = pool.length; }

    // 5) rerank -> assign relevance score
    if (C.RAG_USE_RERANK) {
        pool = await llmRerank(standalone, pool, C.CHAT_MODEL);
        const n = pool.length;
        pool.forEach((it, i) => { it.rel = (n - i) / n; });
        dbg.stages.reranked = true;
    } else {
        pool.forEach(it => { it.rel = typeof it.similarity === 'number' ? it.similarity : 0.5; });
    }

    // 6) select final K (MMR or top-K)
    const mmrUsable = C.RAG_USE_MMR && pool.every(it => it.embedding);
    let chosen = mmrUsable ? mmrSelect(pool, TOP_K, Number(C.RAG_MMR_LAMBDA)) : pool.slice(0, TOP_K);
    dbg.stages.select = mmrUsable ? 'mmr' : 'topK';
    dbg.stages.chosen = chosen.length;

    // 7) build context + answer
    const trimmed = trimContextBlocks(chosen, Number(C.RAG_MAX_CTX_CHARS));
    if (trimmed.length === 0 || trimmed.every(m => !m.content?.trim())) {
        return { answer: 'Nem találtam megfelelő minőségű információt ehhez a kérdéshez. Próbálj meg máshogy megfogalmazni!', sources: [], debug: C.RAG_DEBUG ? dbg : undefined };
    }
    const numbered = trimmed.map((m, i) => `[${i + 1}] ${m.content}`).join('\n\n');
    const user = `KONTEKSTUS:\n${numbered}\n\nKÉRDÉS:\n${standalone}\n\nVálaszolj a fenti kontextus alapján.`;

    const r = await openai.chat.completions.create({
        model: C.CHAT_MODEL,
        temperature: 0.4,
        messages: [
            { role: 'system', content: systemPromptHu() },
            { role: 'user', content: user },
        ],
    });
    const answer = r.choices?.[0]?.message?.content ?? '';

    return {
        answer,
        standalone,
        sources: trimmed.map((m, i) => ({
            index: i + 1, id: m.id, document_id: m.document_id,
            chunk_index: m.chunk_index, similarity: m.similarity,
        })),
        debug: C.RAG_DEBUG ? dbg : undefined,
    };
}
