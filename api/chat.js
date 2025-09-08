import { answerWithRag } from './_utils/rag.js';

// --- Body parser guard (Vercel / Node különbségek miatt) ---
function safeBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    try {
        if (typeof req.body === 'string') return JSON.parse(req.body);
    } catch { }
    return {};
}

// --- Minimal CORS / preflight (ha később más originről hívnád) ---
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // --- ENV guard (ne dobjunk 500-at a kliensnek) ---
        const okEnv = !!process.env.OPENAI_API_KEY
            && !!process.env.SUPABASE_URL
            && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!okEnv) {
            console.error('ENV MISSING', {
                has_OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
                has_SUPABASE_URL: !!process.env.SUPABASE_URL,
                has_SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY
            });
            // 200-at adunk vissza, hogy a frontenden ne "Hálózati hiba" jelenjen meg
            return res.status(200).json({
                reply: 'A szerver konfigurációja hiányos. Próbáld meg később.'
            });
        }

        const body = safeBody(req);
        let { message, history = [], locale = undefined, productId = null, lockLocale = false } = body;

        // --- Bejövő adatok normalizálása ---
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(200).json({ reply: 'Kérlek, írd meg mire vagy kíváncsi.' });
        }
        // History: csak {role, content} párok, utolsó 12
        if (!Array.isArray(history)) history = [];
        history = history
            .filter(m => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string')
            .slice(-12);

        // ProductId: üres stringből legyen null
        if (productId === '' || productId === undefined) productId = null;
        if (productId != null) {
            const n = Number(productId);
            productId = Number.isFinite(n) ? n : null;
        }

        // --- RAG válasz ---
        const { reply, citations, productContext, replyLang } = await answerWithRag({
            message,
            history,
            locale,
            productId,
            lockLocale
        });

        // --- Biztonságos defaultok a kliensnek ---
        return res.status(200).json({
            reply: reply || 'Váratlan hiba történt. Próbáld újra pár perc múlva.',
            citations: Array.isArray(citations) ? citations : [],
            productContext: productContext || { currentProductId: null },
            replyLang: replyLang || 'en'
        });

    } catch (err) {
        // Soha ne adjunk 500-at → a front-end ne lásson “Hálózati hiba”-t
        console.error('api/chat fatal:', err);
        return res.status(200).json({
            reply: 'Váratlan hiba történt a feldolgozás során. Kérlek próbáld újra később.'
        });
    }
}