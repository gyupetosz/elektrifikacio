import { answerWithRag } from './_utils/rag.js';

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN || reqOriginFallback(res));
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Cache-Control', 'no-store');
}

function reqOriginFallback(res) {
    // fallback to same origin if available, else block with empty string:
    const o = res.req?.headers?.origin;
    return typeof o === 'string' ? o : '';
}

function safeJsonParse(maybeString) {
    if (typeof maybeString === 'string') {
        try { return JSON.parse(maybeString); } catch { return null; }
    }
    return typeof maybeString === 'object' && maybeString !== null ? maybeString : null;
}

export default async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        return res
            .status(200)
            .setHeader('Content-Type', 'text/html; charset=utf-8')
            .send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:40px;max-width:840px">
        <h1>Policy Assistant</h1>
        <form id="f"><input name="q" placeholder="Ask a policy question…" style="padding:10px;width:70%"><button>Ask</button></form>
        <pre id="out" style="white-space:pre-wrap;margin-top:1rem;color:#111"></pre>
        <script>
          f.onsubmit = async (e)=>{e.preventDefault(); out.textContent='…';
            const r = await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query: f.q.value})});
            const j = await r.json(); out.textContent = j.error || j.answer || '';
          };
        </script></body>`);
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Basic body guard
    const body = safeJsonParse(req.body);
    if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return res.status(400).json({ error: 'Missing query' });
    if (query.length > 2000) return res.status(413).json({ error: 'Query too long' });

    try {
        const result = await askPolicyRag({ query });
        // { answer, sources: [{index,id,document_id,chunk_index,similarity}] }
        return res.status(200).json(result);
    } catch (e) {
        console.error('[ask] error:', e);
        return res.status(500).json({ error: 'Internal error' });
    }
}