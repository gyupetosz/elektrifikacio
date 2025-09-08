// api/chat.js
import { askPolicyRag } from './_utils/rag.js';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function pickQuery(body) {
    if (!body) return '';
    if (Array.isArray(body.messages) && body.messages.length) {
        const last = body.messages[body.messages.length - 1];
        if (last && typeof last.content === 'string' && last.content.trim()) {
            return last.content.trim();
        }
    }
    return (
        body.query?.toString().trim() ||
        body.message?.toString().trim() ||
        body.text?.toString().trim() ||
        ''
    );
}

// Remove inline [n] citations like [1], [12] (and optional leading space)
function stripCitations(s = '') {
    return String(s)
        .replace(/\s?\[\d+\]/g, '')     // remove [1], [23]
        .replace(/[ ]{2,}/g, ' ')       // collapse double spaces left behind
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
            // Fallback: read the stream body (rare on some runtimes)
            const chunks = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const raw = Buffer.concat(chunks).toString('utf8');
            try { body = JSON.parse(raw); } catch { body = {}; }
        }

        const query = pickQuery(body);
        if (!query) return res.status(400).json({ error: 'Missing query' });

        const result = await askPolicyRag({
            query,
            k: Number(process.env.RAG_TOP_K ?? 6)
        });

        // Strip [n] markers from the model's reply before returning
        const cleaned = stripCitations(result?.answer ?? '');

        return res.status(200).json({
            reply: cleaned,
            // Keep sources in payload (handy for logs/QA), or remove if you don't want to expose them:
            sources: result?.sources ?? []
        });
    } catch (e) {
        console.error('chat handler error:', e);
        return res.status(500).json({ error: e.message || String(e) });
    }
}
