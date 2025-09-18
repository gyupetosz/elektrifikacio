// api/chat.js
import { askPolicyRag } from './_utils/rag.js';
import { RAG_CONFIG } from './_utils/rag_config.js';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function pickQuery(body) { /* változatlan */ }

// Remove inline [n] citations like [1], [12]
function stripCitations(s = '') {
    return String(s)
        .replace(/\s?\[\d+\]/g, '')
        .replace(/[ ]{2,}/g, ' ')
        .trim();
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
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const result = await askPolicyRag({
            query,
            k: Number(RAG_CONFIG.RAG_TOP_K) ?? 10
        });

    const reply = RAG_CONFIG.STRIP_CITATIONS
            ? stripCitations(result?.answer ?? '')
            : (result?.answer ?? '');

        return res.status(200).json({
            reply,
            sources: result?.sources ?? []
        });
    } catch (e) {
        console.error('chat handler error:', e);
        return res.status(500).json({ error: e.message || String(e) });
    }
}
