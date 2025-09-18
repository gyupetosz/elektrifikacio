// api/chat.js
import { askPolicyRag } from './_utils/rag.js';
import { RAG_CONFIG } from './_utils/rag_config.js';

// Node runtime kell a service-role Supabase kliens miatt
export const runtime = 'nodejs';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}


function pickQuery(body) {
    if (!body) return '';
    // OpenAI Chat formátum
    if (Array.isArray(body.messages) && body.messages.length) {
        const last = body.messages[body.messages.length - 1];
        if (last && typeof last.content === 'string' && last.content.trim()) {
            return last.content.trim();
        }
    }
    const keys = ['query', 'message', 'text', 'prompt', 'content'];
    for (const k of keys) {
        const v = body[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

function stripCitations(s = '') {
    return String(s).replace(/\s?\[\d+\]/g, '').replace(/[ ]{2,}/g, ' ').trim();
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch { body = {}; }
        } else if (!body) {
            const chunks = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const raw = Buffer.concat(chunks).toString('utf8');
            try { body = JSON.parse(raw); } catch { body = {}; }
        }

        const query = pickQuery(body);
        if (!query) {
            return res.status(400).json({ error: 'Missing query' });
        }

        const result = await askPolicyRag({ query, k: 12 });
        let reply = result?.answer;
        if (typeof reply !== 'string' || !reply.trim()) {
            reply = 'A megadott kontextus alapján nem tudok releváns választ adni.';
        }
        return res.status(200).json({
            reply,
            sources: Array.isArray(result?.sources) ? result.sources : []
        });
    } catch (e) {
        console.error('chat handler error:', e, e?.meta);
        return res.status(500).json({ error: e.message || String(e) });
    }
}