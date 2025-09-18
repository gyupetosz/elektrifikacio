// api/_utils/policy_rag.mjs
import OpenAI from 'openai';
import { supabase } from './supabase.js';
import { embedQuery, EMBEDDING_DIM } from './embeddings.js';  // returns 1536-dim array

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const EMBEDDING_DIM = 1536;
const TOP_K = Math.min(Number(process.env.RAG_TOP_K || 10), 16);
const MIN_LEN = Number(process.env.RAG_MIN_CHUNK_LENGTH || 20);
const MAX_CTX_CHARS = Number(process.env.RAG_MAX_CTX_CHARS || 8000); // kb. 5–6k token
const USE_HYBRID = process.env.RAG_USE_HYBRID === '1';

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

/**
 * Magyar rendszerprompt EV/RAG asszisztenshez
 * - szigorúan a megadott KONTEKSTUSBÓL válaszol
 * - idéz [1], [2] formában
 * - tömör, lépéses magyarázatnál számozott listát használ
 * - képleteknél megőrizhető a LaTeX formázás, de magyarázzon is röviden
 */
function systemPromptHu() {
    return `
Te egy szigorú RAG-alapú „Elektrifikációs Asszisztens” vagy.

SZEREP ÉS HATÓKÖR
- Elsődlegesen a megadott KONTEKSTUS alapján válaszolj.
- Ha a kérdésre nincs szó szerinti válasz, de a KONTEKSTUS tartalmaz tartalmilag egyenértékű állítást vagy definíciót, add meg a választ parafrázisban a megfelelő hivatkozással.
- Számításokat (pl. töltési idő, hatótáv) elvégezhetsz a KONTEKSTUSBAN szereplő képletek és adatok alapján, de ne találj ki hiányzó paramétereket.


NYELV
- A felhasználó nyelvén válaszolj; ha a kérdés magyar, magyarul válaszolj. Ha a kontextus nem magyar, fogalmazd át magyarul.

STÍLUS
- Légy tömör, egyértelmű és jól tagolt.
- Eljárásoknál/képleteknél használj számozott lépéseket (1), 2), 3) …).
- Ha képletet idézel, megtarthatod a LaTeX jelölést is, de röviden magyarázd el, mit jelent.

HIVATKOZÁSOK
- A válasz végében vagy a releváns állítások után adj hivatkozást a KONTEKSTUS-blokkokra: [1], [2] …, a megadott sorszámozás szerint.

KORLÁTOK
- Ha több lehetséges értelmezés van, jelezd a feltételezéseidet röviden.
- Ne mondj ellent a KONTEKSTUSNAK. Kétség esetén inkább légy óvatos, és javasolj pontosítást.
- Ha nincs EGYÁLTALÁN releváns információ, mondd ki: „A megadott kontextusban erre nincs információm.”

KIMENET
- Csak a választ add vissza (a hivatkozásokkal). Ne csatolj nyers JSON-t, táblákat vagy metaadatokat.
  `.trim();
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

    // 2) Retrieve
    let data, error;
    if (USE_HYBRID) {

        ({ data, error } = await supabase.rpc('match_policy_chunks_hybrid', {
            query_text: query,
            query_embedding: qvec,
            match_count: Math.max(1, Math.min(k, 32)),
            min_content_length: MIN_LEN,
        }));
    } else {
        // eredeti embedding-only RPC
        ({ data, error } = await supabase.rpc('match_policy_chunks', {
            query_embedding: qvec,
            match_count: Math.max(1, Math.min(k, 32)),
            min_content_length: MIN_LEN,
        }));
    }
    if (error) throw error;

    const matches = Array.isArray(data) ? data : [];
    if (matches.length === 0) {
        return {
            answer: 'Nem találtam idevágó részletet a tudásbázisban ehhez a kérdéshez.',
            sources: []
        };
    }

    // 3) Kontextus építés
    const trimmed = trimContextBlocks(matches);
    const numbered = trimmed.map((m, i) => `[${i + 1}] ${m.content}`).join('\n\n');

    // 4) Prompt + válasz
    const sys = systemPromptHu();
    const user = `KONTEKSTUS:\n${numbered}\n\nKÉRDÉS:\n${query}\n\nVálaszolj a fenti kontextus alapján, hivatkozásokkal mint [1], [2]… a megfelelő blokkokra.`;

    const r = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user }
        ],
        temperature: 0.3
    });

    const answer = r.choices?.[0]?.message?.content ?? '';

    return {
        answer,
        sources: trimmed.map((m, i) => ({
            index: i + 1,
            id: m.id,
            document_id: m.document_id,
            chunk_index: m.chunk_index,
            similarity: m.similarity
        }))
    };
}
