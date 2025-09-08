import { answerWithRag } from './_utils/rag.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function pickQuery(body) {
  if (!body) return '';
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    if (last && typeof last.content === 'string' && last.content.trim()) return last.content.trim();
  }
  return (
    body.query?.toString().trim() ||
    body.message?.toString().trim() ||
    body.text?.toString().trim() ||
    ''
  );
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
      // Fallback: olvassuk ki a streamet (ritka eset)
      const chunks = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = JSON.parse(raw); } catch { body = {}; }
    }

    const query = pickQuery(body);
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const result = await askPolicyRag({ query, k: Number(process.env.RAG_TOP_K ?? 6) });

    return res.status(200).json({
      reply: result.answer,
      sources: result.sources
    });
  } catch (e) {
    console.error('chat handler error:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}