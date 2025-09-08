// _utils/rag.js — multilingual-ready (EN/HU/DE) with robust product locking and fuzzy name resolution
import OpenAI from 'openai';
import { supabase } from './supabase.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ------------------- Config: locales ------------------- **/
export const SUPPORTED_LOCALES = ['hu', 'en']; // add 'de' when docs are ready

export function normalizeLocaleTag(tag) {
    const t = String(tag || '').toLowerCase();
    if (t.startsWith('en')) return 'en';
    if (t.startsWith('hu')) return 'hu';
    if (t.startsWith('de')) return 'de';
    return null;
}

/** ------------------- Lightweight language detection via OpenAI ------------------- **/
export async function detectLocaleOpenAI(message) {
    const input = String(message || '').slice(0, 1000).trim();
    if (!input) return null;
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            max_tokens: 3,
            messages: [
                { role: 'system', content: 'Reply with exactly one of these language codes: en | hu | de. If unsure, reply en.' },
                { role: 'user', content: input }
            ]
        });
        const raw = (completion?.choices?.[0]?.message?.content || '').trim().toLowerCase();
        const lang = ['en', 'hu', 'de'].includes(raw) ? raw : 'en';
        const norm = normalizeLocaleTag(lang);
        if (norm && SUPPORTED_LOCALES.includes(norm)) return norm;
        return null;
    } catch (err) {
        console.warn('[lang-detect] OpenAI error:', err?.message || err);
        return null;
    }
}

export async function resolveLocales({ message, requestedLocale = null, forceRequested = false }) {
    const ordered = [];
    const add = (x) => {
        const v = normalizeLocaleTag(x);
        if (v && SUPPORTED_LOCALES.includes(v) && !ordered.includes(v)) ordered.push(v);
    };

    const raw = String(message || '');
    const lower = raw.toLowerCase();

    const count = (re) => (lower.match(re) || []).length;
    const HU_WORDS = /\b(es|vagy|az|nem|melyik|milyen|hogy|egy|van|nincs|kell|mit|mikor|hogyan|ajanl\w*|term[eé]k\w*|osszet[eé]v\w*|ossz[eé]s\w*|haszn[aá]lat\w*|adagol[aá]s?\w*|kinek|mire)\b/g;
    const HU_DIGRAPHS = /(gy|ny|ty|sz|zs|cs|ly)/g;
    const HU_SUFFIXES = /\b\w{3,}(ban|ben|nak|nek|val|vel|hoz|hez|hoz|rol|rol|tol|tol|bol|bol|ba|be|ra|re|nal|nel|kor)\b/g;
    const EN_WORDS = /\b(the|and|or|which|what|how|is|are|do|does|can|should|product|ingredients|price|link)\b/g;
    const DE_WORDS = /\b(und|oder|nicht|welche[rsn]?|was|wie|ist|sind|produkt|zutaten|preis|link|kaufen|nehmen|hilft|spray)\b/g;

    const scoreHU = count(HU_WORDS) * 2 + count(HU_DIGRAPHS) + count(HU_SUFFIXES) * 2;
    const scoreEN = count(EN_WORDS) * 2;
    const scoreDE = count(DE_WORDS) * 2 + (/[äöüß]/i.test(raw) ? 2 : 0);

    let heuristic = null;
    const maxOther = Math.max(scoreEN, scoreDE);
    if (scoreHU >= maxOther + 1 || scoreHU >= 3) heuristic = 'hu';
    else if (scoreDE >= Math.max(scoreHU, scoreEN) + 1 || scoreDE >= 3) heuristic = 'de';
    else if (scoreEN >= 2) heuristic = 'en';
    else if (/[a-z]{4,}/.test(lower) && count(HU_DIGRAPHS) >= 2) heuristic = 'hu';

    let detected = null;
    try { detected = await detectLocaleOpenAI(message); } catch { }

    if (forceRequested) add(requestedLocale);
    add(detected || heuristic);
    if (!forceRequested) add(requestedLocale);
    for (const l of SUPPORTED_LOCALES) add(l);

    return ordered;
}

/** ------------------- Retrieval ------------------- **/
export async function retrieveTopChunks(queryEmbedding, { locale = 'hu', productId = null, k = 8, docTypes = ['product', 'faq', 'policy'] } = {}) {
    const { data, error } = await supabase.rpc('match_chunks', {
        query_embedding: queryEmbedding,
        match_count: k,
        p_locale: locale,
        p_product_id: productId,
        p_doctypes: docTypes
    });
    if (error) { console.error('match_chunks error:', error); return []; }
    return data || [];
}

async function retrieveTopChunksMulti(queryEmbedding, { locales = ['hu'], productId = null, k = 8, docTypes }) {
    const seen = new Set();
    const out = [];
    for (const loc of locales) {
        const rows = await retrieveTopChunks(queryEmbedding, { locale: loc, productId, k, docTypes });
        for (const r of rows) {
            const key = r?.metadata?.product_url || `${r?.doc_id}|${r?.section_title}|${String(r?.content || '').slice(0, 80)}`;
            if (!seen.has(key)) { seen.add(key); out.push(r); }
        }
        if (out.length >= k) break;
    }
    return out.slice(0, k);
}

/** ------------------- Context packer ------------------- **/
export function buildContext(chunks) {
    return (chunks || [])
        .slice(0, 8)
        .map((c, i) => {
            const title = c?.metadata?.title ?? c?.section_title ?? '';
            const body = String(c?.content ?? '').slice(0, 1200);
            return `[CONTEXT #${i + 1}] ${title}\n${body}`;
        })
        .join('\n\n');
}

/** ------------------- Robust Product ID helpers ------------------- **/
// NOTE: English site sometimes shows 1000-range in URL, yet canonical IDs may be 1100+ in DB.
// We implement robust parsing from URL and fallbacks via title fuzzy match + docs lookup.

export function productIdFromUrl(u) {
    const s = String(u || '');
    // capture numeric ID segment after known slugs
    const m = s.match(/\/(?:produktdetails|product|products|termek|termekek)\/(\d+)(?:\/|$)/i);
    if (!m) return null;
    let pid = Number(m[1]);
    if (!Number.isFinite(pid)) return null;
    // Heuristic adjust: if English path uses 1000-range but DB uses 1100+, try +100 offset if no direct match later
    return pid;
}

// Heuristic mapping: if a product id X not found, try X+100 (to bridge 1000↔1100 gaps)
async function tryAdjustIdIfMissing(pid) {
    if (pid == null) return null;
    // verify existence in docs
    const { data } = await supabase
        .from('docs')
        .select('product_id')
        .eq('doc_type', 'product')
        .eq('product_id', String(pid))
        .limit(1);
    if (data && data.length) return pid;
    const alt = pid + 100;
    const { data: d2 } = await supabase
        .from('docs')
        .select('product_id')
        .eq('doc_type', 'product')
        .eq('product_id', String(alt))
        .limit(1);
    if (d2 && d2.length) return alt;
    return pid; // fallback to original even if not present; caller may fuzzy-resolve later
}

function inferProductIdFromChunks(chunks = []) {
    for (const c of chunks) {
        const pid = productIdFromUrl(c?.metadata?.product_url);
        if (pid) return pid;
    }
    return null;
}

function inferProductIdFromHistory(history = []) {
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.role === 'assistant') {
            const pid = productIdFromUrl(h.content);
            if (pid) return pid;
        }
    }
    return null;
}

/** ------------------- Normalizers & embed sanitizers ------------------- **/
function norm(s = '') { return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function sanitizeForEmbedding(text = '') {
    const noUrls = String(text).replace(/https?:\/\/\S+/g, ' ');
    const noProdIds = noUrls.replace(/\/(?:produktdetails|product|products|termek|termekek)\/\d+(?:\/|\b)/gi, ' ');
    return noProdIds.slice(0, 2000);
}
function buildExpandedQuery(message, history = [], { altIntent = false } = {}) {
    if (altIntent) return `USER: ${message}`;
    const lastTurns = history
        .slice(-6)
        .map((m) => `${m.role.toUpperCase()}: ${sanitizeForEmbedding(m.content)}`)
        .join('\n');
    return [lastTurns, `USER: ${message}`].filter(Boolean).join('\n');
}

/** ------------------- Intents ------------------- **/
function isListIntent(text = '') {
    const q = norm(text);
    // gyakori magyar alakok + elgépelések
    const huKeys = [
        'termeklista', 'terméklista', 'kinalat', 'kínálat', 'katalogus', 'katalógus',
        'osszes termek', 'összes termék', 'mutasd az osszes', 'mutasd az összes',
        'mutasd a termekeket', 'mutasd a termékeket', 'listazd', 'listázd', 'sorold fel', 'felsorol',
        'termekek listaja', 'termékek listája', 'milyen termekek', 'mit tudok venni', 'elerheto termekek', 'mit vasarolhatok',
        'mit vásárolhatok', 'milyen termékek', 'miket tudok venni', 'miket vasarolhatok', 'miket vásárolhatok'
    ];
    const enKeys = ['all products', 'list products', 'product list', 'show all', 'catalog', 'assortment'];
    const deKeys = ['alle produkte', 'produkte auflisten', 'produktliste', 'zeige alle', 'sortiment', 'katalog'];

    // ha „termék”+„mutasd/listázd/sorold” együtt szerepel, az erős jel
    const comboHU = /\b(term[eé]k\w*).*\b(mutasd|list[aá]zd|sorold|felsorol)\b|\b(mutasd|list[aá]zd|sorold|felsorol).*\b(term[eé]k\w*)\b/;

    return huKeys.some(w => q.includes(norm(w))) ||
        enKeys.some(w => q.includes(norm(w))) ||
        deKeys.some(w => q.includes(norm(w))) ||
        comboHU.test(q);
}
function isAlternativeIntent(text = '') {
    const q = norm(text);
    const keys = ['ajánlj másik', 'másik termék', 'valami mást', 'ajánlj valamit', 'ajánlj egy másik terméket', 'ajánlj egy másikat', 'melyik termék', 'melyik jó', 'melyik a legjobb', 'melyik a legjobb termék', 'melyik segít', 'melyik termék segít', 'melyikben van', 'melyik termékben van', 'mit szedjek', 'mit vegyek', 'melyik a legjobb választás', 'spray formátum', 'spray formátumú', 'spray', 'recommend another', 'another product', 'something else', 'recommend something', 'suggest a product', 'which product', 'which is good', 'which is the best', 'best product', 'what helps', 'looking for', 'look for', 'which helps', 'what should i take', 'what heals', 'what should i buy', 'best choice', 'spray format', 'what do you recommend', 'what do you suggest', 'what would you suggest', 'what would you recommend', 'empfiehl', 'empfehle', 'anderes produkt', 'etwas anderes', 'produkt vorschlagen', 'welches produkt', 'welches ist gut', 'welches ist das beste', 'bestes produkt', 'welches hilft', 'was soll ich nehmen', 'was soll ich kaufen', 'beste wahl', 'sprühform', 'spray format'];
    const pattern = /^(melyik|mit\s+(szedjek|vegyek)|ajánlj|recommend|suggest|which|what\s+should\s+i\s+(take|buy)|empfiehl|empfehle|welches|was\s+soll\s+ich\s+(nehmen|kaufen))/;
    return keys.some((w) => q.includes(norm(w))) || pattern.test(q);
}
function isBroadProductQuery(text = '') { return isListIntent(text); }

/** ------------------- Product selection helpers ------------------- **/
function pickTopProducts(hits = [], { excludeProductId = null, max = 3, lang = 'hu' } = {}) {
    const byPid = new Map();
    for (const h of hits) {
        const url = h?.metadata?.product_url;
        if (!url) continue;
        const pid = productIdFromUrl(url) ?? h.product_id ?? null;
        if (excludeProductId != null && Number(pid) === Number(excludeProductId)) continue;
        const arr = byPid.get(pid) || [];
        arr.push(h);
        byPid.set(pid, arr);
    }
    const out = [];
    for (const [pid, arr] of byPid.entries()) {
        const hu = arr.find(x => x?.locale === lang && x?.metadata?.product_url);
        const any = arr.find(x => x?.metadata?.product_url);
        const picked = hu || any;
        if (!picked) continue;
        out.push({
            title: picked?.metadata?.title || picked?.section_title || 'Genex termék',
            url: picked?.metadata?.product_url,
            product_id: pid,
            chunk: picked
        });
        if (out.length >= max) break;
    }
    return out;
}

/** ---- Keywords from message ---- **/
function keywordsFromMessage(msg = '') {
    const q = norm(msg);
    const quoted = [...q.matchAll(/["“”'‘’](.+?)["“”'‘’]/g)].map((m) => m[1].trim().toLowerCase());
    const base = q.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/);
    const stop = new Set(['melyik', 'milyen', 'tartalmaz', 'termek', 'terméket', 'van', 'benne', 'ami', 'amely', 'a', 'az', 'és', 'vagy', 'mit', 'jó', 'segít', 'legjobb', 'formátumú', 'formátum', 'which', 'what', 'is', 'it', 'for', 'does', 'contain', 'product', 'the', 'and', 'or', 'should', 'i', 'take', 'buy', 'best', 'welches', 'was', 'ist', 'es', 'für', 'enthält', 'produkt', 'und', 'oder', 'soll', 'ich', 'nehmen', 'kaufen', 'beste']);
    let toks = [...quoted, ...base.filter((t) => t.length >= 3 && !stop.has(t))];
    const addIf = (cond, arr) => { if (cond) toks = toks.concat(arr); };
    addIf(/alg|alga|chlorell|spirulin|alge/i.test(q), ['alga', 'algae', 'chlorella', 'spirulina', 'alge', 'algen']);
    addIf(/sejt|őssejt|ossejt|regener|megújul|megujul|stem\s*cell|regenerati|renew|stammzell|erneuer/i.test(q), ['sejt', 'őssejt', 'ossejt', 'regeneracio', 'regener', 'megújul', 'stem cell', 'regeneration', 'renew', 'stammzell']);
    addIf(/bőr|bor|skin|haut|fertotlen|fertőtlen|antiszept|antisept|dezinf|desinfiz|tisztit|tisztítás|reinigung|cleanse|clean/i.test(q), ['bőr', 'skin', 'haut', 'fertőtlen', 'antiszept', 'antiseptic', 'dezinf', 'desinfiz', 'tisztitas', 'reinigung', 'cleansing']);
    addIf(/spray|permet|nasal|orrspray|pumpa|mist|pump|nasenspray|sprüh/i.test(q), ['spray', 'permet', 'nasal', 'orrspray', 'pumpas', 'mist', 'pump', 'nasenspray']);
    return [...new Set(toks)];
}

function pickBestProductByScore(hits = [], { excludeProductId = null, message = '' } = {}) {
    if (!hits.length) return null;
    const toks = keywordsFromMessage(message);
    const wantsSpray = ['spray', 'permet', 'nasal', 'orrspray', 'pumpas', 'pump', 'mist', 'nasenspray'].some(t => toks.includes(t));
    const groups = new Map();
    hits.forEach((h, idx) => {
        const url = h?.metadata?.product_url; if (!url) return;
        const pid = productIdFromUrl(url) ?? h.product_id ?? null;
        if (excludeProductId != null && Number(pid) === Number(excludeProductId)) return;
        const arr = groups.get(url) || []; arr.push({ h, idx, pid }); groups.set(url, arr);
    });
    if (!groups.size) return null;
    const hardIngredients = new Set(['alga', 'algae', 'chlorella', 'spirulina', 'ossejt', 'őssejt', 'os-sejt', 'stem cell', 'regener', 'regeneracio', 'regeneration', 'renew', 'megújul', 'alge', 'algen', 'stammzell', 'erneuer']);
    const hardSkin = new Set(['bőr', 'bor', 'skin', 'haut', 'fertotlen', 'fertőtlen', 'antiszept', 'antisept', 'dezinf', 'desinfiz', 'tisztitas', 'tisztítás', 'reinigung', 'cleansing']);
    let best = null, bestScore = -1;
    for (const [url, arr] of groups.entries()) {
        let score = 0, sprayFlag = false;
        for (const { h, idx } of arr) {
            const title = norm(h?.metadata?.title || '');
            const sect = norm(h?.section_title || '');
            const body = norm(h?.content || '');
            const text = `${title} ${sect} ${body}`;
            if (/spray|permet|nasal|orrspray|pumpa|mist|nasenspray|sprüh/.test(text)) sprayFlag = true;
            for (const t of toks) {
                if (!t || t.length < 3) continue;
                if (text.includes(t)) {
                    if (hardIngredients.has(t)) score += 6;
                    else if (hardSkin.has(t)) score += 5;
                    else score += 2;
                }
            }
            score += Math.max(0, 5 - Math.min(idx, 5));
        }
        if (wantsSpray) score += sprayFlag ? 12 : -6;
        if (score > bestScore) { best = { title: arr[0].h?.metadata?.title || arr[0].h?.section_title || 'Genex termék', url, product_id: arr[0].pid }; bestScore = score; }
    }
    if (!best) { const [url, arr] = [...groups.entries()][0]; const any = arr[0]; best = { title: any.h?.metadata?.title || any.h?.section_title || 'Genex termék', url, product_id: any.pid }; }
    return best;
}

function wantsPolicyIntent(message) {
    const txt = (message || "").toLowerCase();

    // tipikus policy kulcsszavak
    const POLICY_TERMS = [
        "szállítás", "futár", "rendelés", "visszaküldés", "garancia",
        "ár", "fizetés", "kiszállítás", "szállítási idő",
        "jutalék", "kifizetés", "iban", "utalás", "szponzor", "regisztráció", "webiroda"
    ];

    return POLICY_TERMS.some(term => txt.includes(term));
}

/** ------------------- Domain detection ------------------- **/
function detectDomain(text = '', history = []) {
    const q = norm(text);
    const policyWords = ['szabály', 'szabályzat', 'policy', 'jutalék', 'kifizetés', 'fizetés', 'iban', 'bankszámla', '20 eur', 'göngyölít', 'átutalás', 'webiroda', 'profil', 'bankadatok', 'cégadatok', 'alapadatok', 'rendelés', 'módosítás', 'függőben', 'sikertelen bankkártyás', 'banki utalás', 'euró', 'árfolyam', 'regisztráció', 'partner', 'distributor', 'vásárló', 'szponzor', 'tank', 'struktúra', 'bal láb', 'jobb láb', '18 éves', 'számla', 'adószám', 'helyesbítő számla', 'szállítás', 'csomagolás', 'sérült termék', 'elveszett csomag', 'futár', 'különleges csomagolás', 'bejelentkezés', 'jelszó visszaállítás', 'videó', 'youtube', 'mlm', 'marketing terv', 'qp', 'karrierszint', 'bónusz', 'direkt bónusz', 'indirekt bónusz', 'start bónusz', 'turbó bónusz', 'további vásárlási bónusz', 'bináris bónusz', 'globális vezetői pool', 'wallet', 'heti kifizetés', 'hogyan kell szedni', 'adagolás', 'adagolas', 'napi', 'kapszula', 'bevétel', 'bevetel', 'szedés', 'szedes', 'commission', 'commissions', 'payout', 'payouts', 'payment', 'bank account', 'threshold', 'carry over', 'transfer', 'back office', 'bank details', 'company data', 'order', 'modify order', 'pending', 'card payment failed', 'bank transfer', 'euro', 'exchange rate', 'registration', 'customer', 'sponsor', 'structure', 'left leg', 'right leg', '18 years', 'invoice', 'tax number', 'vat number', 'corrective invoice', 'shipping', 'packaging', 'damaged product', 'lost package', 'courier', 'special packaging', 'login', 'password reset', 'videos', 'marketing plan', 'rank', 'bonus', 'direct bonus', 'indirect bonus', 'start bonus', 'turbo bonus', 'additional purchase bonus', 'binary bonus', 'global leadership pool', 'weekly payout', 'how to take', 'dosage', 'dose', 'per day', 'capsule', 'capsules', 'take before', 'take after', 'usage', 'administration', 'consumption', 'provision', 'provisionen', 'auszahlung', 'zahlung', 'bankkonto', 'schwelle', 'überweisung', 'backoffice', 'profil', 'bankdaten', 'unternehmensdaten', 'bestellung', 'änderung', 'ausstehend', 'kartenzahlung fehlgeschlagen', 'banküberweisung', 'wechselkurs', 'registrierung', 'kunde', 'rang', 'rechnung', 'steuernummer', 'ust-idnr', 'korrekturrechnung', 'versand', 'verpackung', 'beschädigt', 'verlorenes paket', 'kurier', 'sonderverpackung', 'anmeldung', 'passwort zurücksetzen', 'videos', 'marketingplan', 'zusätzlicher einkaufsbonus', 'wöchentliche auszahlung', 'wie einnehmen', 'einnahme', 'dosierung', 'anwendung', 'verbrauch'];
    const productWords = ['termek', 'termék', 'összetev', 'alapanyag', 'spray', 'ár', 'link', 'ellenjavallat', 'kinek ajánlott', 'tartalmaz', 'melyikben van', 'product', 'ingredient', 'ingredients', 'price', 'contraindication', 'who is it for', 'contains', 'which contains', 'produkt', 'zutat', 'zutaten', 'inhaltsstoff', 'inhaltsstoffe', 'preis', 'kontraindikation', 'für wen empfohlen', 'enthält', 'welche enthält'];
    const hit = (arr) => arr.some((w) => q.includes(norm(w)));
    if (hit(policyWords)) return 'policy';
    if (hit(productWords)) return 'product';
    const last = norm(history.slice(-4).map((h) => h.content).join(' '));
    if (last.includes('policy') || last.includes('szabaly') || last.includes('szabály')) return 'policy';
    if (last.includes('gyik') || last.includes('faq')) return 'faq';
    return 'product';
}

/** ------------------- Ingredients / Usage ------------------- **/
function wantsIngredients(q = '') {
    const s = norm(q);
    const keys = ['összetevő', 'összetevők', 'alapanyag', 'tartalmaz', 'melyikben van', 'van benne', 'ingredient', 'ingredients', 'contains', 'what contains', 'which contains', 'is it in', 'what is in', 'zutat', 'zutaten', 'inhaltsstoff', 'inhaltsstoffe', 'enthält', 'was enthält', 'welche enthält', 'ist drin'];
    return keys.some((w) => s.includes(norm(w)));
}
function wantsUsage(q = '') {
    const s = norm(q);
    const keys = ['hogyan kell szedni', 'adagolás', 'adagolas', 'napi', 'kapszula', 'bevétel', 'bevetel', 'szedés', 'szedes', 'how to take', 'dosage', 'dose', 'per day', 'capsule', 'capsules', 'take before', 'take after', 'usage', 'wie nimmt man', 'dosierung', 'täglich', 'kapsel', 'einnahme', 'anwenden', 'anwendung'];
    const patt = /(hogyan\s+kell\s+szedni|adagol(a|á)s|napi\s+\d+|kapszul[aá]|e?vétel|bevétel|einnahme|dosierung|how\s+to\s+take|dosage)/i;
    return keys.some((w) => s.includes(norm(w))) || patt.test(q);
}

function prioritizeIngredients(arr, currentProductId = null) {
    return arr.slice().sort((a, b) => score(b, currentProductId) - score(a, currentProductId));
    function score(h, pid) {
        let s = 0; const txt = String(h.content || '');
        if (h?.metadata?.subtype === 'ingredients_list') s += 1000;
        if (/##\s*Összetevők/i.test(txt)) s += 200;
        if (/^(-|–|•)\s+/m.test(txt)) s += 50;
        if (pid != null && h?.product_id && Number(h.product_id) === Number(pid)) s += 25;
        return s;
    }
}

function pidOfRow(r) {
    return productIdFromUrl(r?.metadata?.product_url) ?? (r?.product_id != null ? Number(r.product_id) : null);
}

function filterHitsToProduct(hits = [], pid = null) {
    if (pid == null) return hits; return hits.filter((h) => Number(pidOfRow(h)) === Number(pid));
}

function bestPidByBullets(hits = []) {
    const score = new Map();
    for (const h of hits) {
        const pid = pidOfRow(h); if (pid == null) continue;
        const m = String(h.content || '').match(/^\s*[-–•]\s+/gm);
        const c = m ? m.length : 0; score.set(pid, (score.get(pid) || 0) + c);
    }
    let best = null, bestC = -1;
    for (const [pid, c] of score.entries()) if (c > bestC) { best = pid; bestC = c; }
    return best;
}

// UPDATED: aggregateIngredients can enforce a specific product id
function aggregateIngredients(hits = [], forcePid = null) {
    const out = []; const seen = new Set();
    const headRe = /\b(összetevők|ingredients?)\b/i;
    const dropRe = /^(videó|video|leírás|leiras|description|összetevők|ingredients?)$/i;
    for (const h of hits || []) {
        if (forcePid != null) {
            const pid = pidOfRow(h);
            if (pid == null || Number(pid) !== Number(forcePid)) continue;
        }
        const txt = String(h.content || '');
        const looksLikeIng = h?.metadata?.subtype === 'ingredients_list' || headRe.test(txt);
        if (!looksLikeIng) continue;
        for (const raw of txt.split(/\r?\n/)) {
            const m = raw.match(/^\s*(?:[-–•]|\d+\.)\s*(.+?)\s*$/);
            if (!m) continue;
            let name = m[1].replace(/\s*[:–-]\s*$/, '').replace(/[ \u00A0]+/g, ' ').trim();
            if (!name || dropRe.test(name)) continue;
            const key = name.toLowerCase();
            if (!seen.has(key)) { seen.add(key); out.push(`- ${name}`); }
        }
    }
    return out.length ? `### Összetevők\n\n${out.join('\n')}\n` : null;
}

function extractIngredientTerms(msg = '') {
    const q = norm(msg);
    const quoted = [...q.matchAll(/["“”'‘’](.+?)["“”'‘’]/g)].map((m) => m[1].trim().toLowerCase());
    if (quoted.length) return quoted;
    const stop = new Set(['melyik', 'milyen', 'tartalmaz', 'termek', 'termeket', 'van', 'benne', 'osszetevo', 'alapanyag', 'ami', 'amely', 'a', 'az', 'es', 'vagy', 'mit']);
    return q.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length >= 3 && !stop.has(t)).slice(0, 3);
}

async function fetchKeywordChunks({ productId, locales = ['hu'], docTypes, limit = 12, extraTerms = [] }) {
    const out = [];
    for (const locale of locales) {
        let q = supabase
            .from('chunks')
            .select('doc_id, product_id, locale, doc_type, section_title, content, metadata, created_at')
            .eq('locale', locale)
            .in('doc_type', docTypes || ['product'])
            .order('created_at', { ascending: false })
            .limit(limit);

        if (productId != null) q = q.eq('product_id', String(productId));

        const ors = [
            'content.ilike.%összetevő%', 'content.ilike.%alapanyag%', 'content.ilike.%ingredients%',
            'content.ilike.%hogyan kell szedni%', 'content.ilike.%adagol%', 'content.ilike.%napi%', 'content.ilike.%kapszul%',
            'content.ilike.%how to take%', 'content.ilike.%dosage%', 'content.ilike.%capsule%',
            'content.ilike.%wie nimmt man%', 'content.ilike.%dosierung%', 'content.ilike.%kapsel%', 'content.ilike.%einnahme%'
        ];
        for (const term of extraTerms || []) {
            const safe = term.replace(/[%_]/g, '');
            if (safe.length >= 3) ors.push(`content.ilike.%${safe}%`);
        }
        q = q.or(ors.join(','));
        const { data, error } = await q;
        if (error) { console.error('keyword fallback error:', error); continue; }
        out.push(...(data || []));
    }
    return out;
}

/** ------------------- Product listing ------------------- **/
async function listProducts({ locales = ['hu'], pageSize = 500 }) {
    const seen = new Set();
    const out = [];
    for (const locale of locales) {
        let from = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const to = from + pageSize - 1;
            const { data, error } = await supabase
                .from('docs')
                .select('product_id, title, url, doc_type, locale, created_at')
                .eq('doc_type', 'product')
                .eq('locale', locale)
                .order('created_at', { ascending: false })
                .range(from, to);
            if (error) { console.error('listAllProducts error:', error); break; }
            if (!data || data.length === 0) break;
            for (const d of data) {
                const key = String(d.product_id || d.url || d.title);
                if (seen.has(key)) continue; seen.add(key); out.push(d);
            }
            if (data.length < pageSize) break; from += pageSize;
        }
    }
    out.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'hu', { sensitivity: 'base' }));
    return out;
}

function suggestLine(lang, title, url) {
    if (lang === 'en') return `My suggestion: <strong>${title}</strong> — <a href="${url}" target="_blank" rel="noopener noreferrer">Find it here</a>.`;
    if (lang === 'de') return `Mein Vorschlag: <strong>${title}</strong> — <a href="${url}" target="_blank" rel="noopener noreferrer">Hier findest du es</a>.`;
    return `Javaslatom: <strong>${title}</strong> — <a href="${url}" target="_blank" rel="noopener noreferrer">Itt megtalálod</a>.`;
}

function renderProductListHTML(items, lang = 'hu') {
    const label = lang === 'en' ? 'Find it here' : lang === 'de' ? 'Hier findest du es' : 'Itt megtalálod';
    const header = lang === 'en' ? 'All available Genex products:' : lang === 'de' ? 'Alle verfügbaren Genex-Produkte:' : 'Elérhető Genex termékek:';
    const lis = items.map((it) => {
        const name = it.title || (lang === 'en' ? 'Genex product' : lang === 'de' ? 'Genex Produkt' : 'Genex termék');
        const href = it.url ? `<a href="${it.url}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
        return `<li>${name}${href ? `&nbsp;—&nbsp;${href}` : ''}</li>`;
    }).join('\n');
    return `\n<p>${header}</p>\n<ul style="padding-left:1.2rem; margin:0;">\n${lis}\n</ul>`.
        trim();
}

function systemPrompt(lang = 'hu') {
    return `
Te egy Genex terméktámogató asszisztens vagy.

NYELVPOLITIKA
- Felhasználói nyelv: ${lang}.
- MINDEN választ kizárólag ezen a nyelven adj. NE válts más nyelvre, kivéve ha a felhasználó kifejezetten fordítást kér, vagy üzenetet vált ${lang}→másik nyelvre.
- Ha a KONTEXTUS más nyelvű, fogalmazd át / fordítsd le a választ ${lang} nyelvre.

SZEREP ÉS HATÓKÖR
- Kizárólag a kapott KONTEXTUS alapján válaszolj; ne tégy feltevéseket, ne egészítsd ki külső tudással.
- Maradj az aktuális Genex terméknél (memóriában tárolt productId), kivéve ha:
  • a felhasználó kifejezetten másik terméket kér, vagy
  • a kérdés tartalma egyértelműen más termékre utal, vagy
  • a kontextus többsége más termékre vonatkozik (pl. összes termék listázása).
- Ha a válasz új termékre vonatkozik, ezt tekintsd aktívnak és írd vissza a memóriába.

HIÁNYOS INFORMÁCIÓ ESETÉN
- Kérj rövid pontosítást (pl. termék neve, altípus, verzió, nyelv).
- KIVÉTEL: ha a felhasználó ajánlást/alternatívát kér, NE kérdezz vissza, hanem javasolj egy legrelevánsabb terméket rövid indoklással és linkkel. A javasolt terméket tekintsd az új aktív terméknek és állítsd be a memóriában.

VÁLASZSTÍLUS
- Lényegre törő válasz
- Eljárásnál számozott lépések: 1), 2), 3) …

LINKEK
- Ha linket kérnek, pontosan ezt add vissza HTML-ként (és csak ezt):
  <a href="AZ_LINK" target="_blank" rel="noopener noreferrer">Link</a>

ÖSSZETEVŐK / LISTÁK
- Ha összetevőkről kérdeznek: gyűjts össze MINDEN idevágó felsorolást a KONTEXTUSBÓL, semmit ne hagyj ki.
- Csak a kontextusban explicit listában szereplő tételeket sorold fel; NE vegyél fel általános kategóriákat vagy olyan tételeket, amik csak a leíró szövegben fordulnak elő.

MEMÓRIA
- Ha a válasz más termékre vonatkozik, mint a korábbi, állítsd át az aktív terméket (productId + név) az újra.
- „Melyik terméknél tartunk most?” → válaszold meg az aktuális aktív termék nevét.

KORLÁTOK
- Ne mondj ellent a KONTEXTUSNAK. Bizonytalan esetben kérj pontosítást.
- **Aktív termék esetén NE keverj be más termékből származó információt.** Ha az aktív termékhez nincs explicit összetevőlista a kontextusban, ezt mondd el röviden (ne találj ki tételeket).
`.
        trim();
}

/** ------------------- NEW: fuzzy name utilities & robust resolvers ------------------- **/
function normalizeTitleLike(s = '') {
    return String(s)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
function diceCoef(a = '', b = '') {
    const A = normalizeTitleLike(a), B = normalizeTitleLike(b);
    if (!A || !B) return 0;
    const bigrams = s => { const arr = []; for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2)); return arr; };
    const A2 = bigrams(A), B2 = new Set(bigrams(B));
    if (!A2.length || !B2.size) return 0;
    let inter = 0; for (const g of A2) if (B2.has(g)) inter++;
    return (2 * inter) / (A2.length + B2.size);
}
const NAME_ALIASES = [
    ['genex immuno spike detox light', 'immuno spike detox light', 'immuno spike', 'spike detox', 'immuno spiker', 'immuno spiker detox light'],
    ['genex vibe spray', 'vibe spray', 'vibe'],
    ['genex cellexis renewal forever', 'cellexis renewal forever', 'cellexis']
];

export function extractProductNameCandidates(text = '') {
    const raw = String(text || '');
    const quoted = [...raw.matchAll(/["“”'‘’]([^"“”'‘’]{2,120})["“”'‘’]/g)].map(m => m[1].trim());
    const heur = [];
    const cap = raw.match(/\b(genex\s+[A-Z][A-Za-z0-9\- ]{2,80})/gi);
    if (cap) heur.push(...cap);
    const tokens = raw.split(/\n|\.|,|;|\(|\)|\[|\]|\{|\}|\s{2,}/).map(s => s.trim()).filter(Boolean);
    for (const t of tokens) if (/genex\s+/i.test(t) && t.length <= 100) heur.push(t);
    const all = [...quoted, ...heur].map(normalizeTitleLike).filter(Boolean);
    return Array.from(new Set(all));
}

async function resolveProductIdByFuzzyTitle({ titleGuess, locales = ['hu', 'en', 'de'], threshold = 0.62 }) {
    if (!titleGuess) return null;
    const variants = new Set([titleGuess]);
    for (const group of NAME_ALIASES) {
        if (group.some(x => normalizeTitleLike(x) === normalizeTitleLike(titleGuess))) {
            for (const v of group) variants.add(v);
        }
    }
    const { data, error } = await supabase
        .from('docs')
        .select('product_id,title,locale,doc_type')
        .eq('doc_type', 'product')
        .in('locale', locales)
        .order('created_at', { ascending: false })
        .limit(600);
    if (error || !data?.length) return null;
    let best = { pid: null, score: 0 };
    for (const row of data) {
        const t = row.title || '';
        let score = 0; for (const v of variants) score = Math.max(score, diceCoef(v, t));
        if (score > best.score) best = { pid: Number(row.product_id) || null, score };
    }
    return (best.score >= threshold && best.pid != null) ? best.pid : null;
}

async function robustResolveProductId({ url = null, titleGuess = null }) {
    // 1) try URL directly
    if (url) {
        const rawPid = productIdFromUrl(url);
        if (rawPid != null) return await tryAdjustIdIfMissing(rawPid);
    }
    // 2) try fuzzy title
    if (titleGuess) {
        const pid = await resolveProductIdByFuzzyTitle({ titleGuess, locales: SUPPORTED_LOCALES });
        if (pid != null) return pid;
    }
    return null;
}

async function robustInferProductIdFromReply({ replyText = '', hits = [], fallbackPid = null }) {
    // try URL in reply
    const urls = String(replyText).match(/https?:\/\/\S+/g) || [];
    for (const u of urls) {
        const pid = await robustResolveProductId({ url: u });
        if (pid != null) return pid;
    }
    // try product names in reply
    const names = extractProductNameCandidates(replyText);
    for (const nm of names) {
        const pid = await robustResolveProductId({ titleGuess: nm });
        if (pid != null) return pid;
    }
    // infer from hits metadata
    const fromHits = inferProductIdFromChunks(hits);
    if (fromHits != null) return await tryAdjustIdIfMissing(fromHits);
    // fallback
    return fallbackPid;
}

/** =========================
    UPDATED answerWithRag()
    ========================= */
export async function answerWithRag({ message, history = [], locale = null, productId = null, lockLocale = false }) {
    const safeSystemPrompt = (lang) => {
        if (typeof systemPrompt === 'function') return systemPrompt(lang);
        return lang === 'hu'
            ? 'Te egy RAG-asszisztens vagy. Csak a kapott kontextusra támaszkodj. Ha a felhasználó "összetevők"-et kér, a kontextusban szereplő bullet listát add vissza változtatás nélkül. Ne találj ki új tételeket.'
            : 'You are a RAG assistant. Answer strictly from provided context. If the user asks for ingredients, return the bullet list verbatim; do not invent new items.';
    };

    const safeInferProductIdFromChunks = (arr) => {
        try { if (typeof inferProductIdFromChunks === 'function') return inferProductIdFromChunks(arr); } catch { }
        return null;
    };

    const havePrioritize = typeof prioritizeIngredients === 'function';
    const _prioritizeIngredients = havePrioritize
        ? (arr, pid) => prioritizeIngredients(arr, pid)
        : (arr, pid) => arr.slice().sort((a, b) => {
            const ac = String(a.content || ''), bc = String(b.content || '');
            const as = (a?.metadata?.subtype === 'ingredients_list' ? 1000 : 0) + (/##\s*Összetevők/i.test(ac) ? 200 : 0) + (/^(-|–|•)\s+/m.test(ac) ? 50 : 0) + (pid != null && a?.product_id && Number(a.product_id) === Number(pid) ? 25 : 0);
            const bs = (b?.metadata?.subtype === 'ingredients_list' ? 1000 : 0) + (/##\s*Összetevők/i.test(bc) ? 200 : 0) + (/^(-|–|•)\s+/m.test(bc) ? 50 : 0) + (pid != null && b?.product_id && Number(b.product_id) === Number(pid) ? 25 : 0);
            return bs - as;
        });

    try {
        const locales = await resolveLocales({ message, requestedLocale: locale, forceRequested: !!lockLocale });
        const replyLang = locales[0] || 'hu';

        // 1) domain / intents
        let domain = detectDomain(message, history);
        if (wantsPolicyIntent(message)) {
            domain = "policy";
        }
        const wantIng = wantsIngredients(message);
        const wantUsage = wantsUsage(message);

        let docTypes;
        if (wantUsage || wantIng) docTypes = ['policy', 'faq', 'product'];
        else docTypes = domain === 'product' ? ['product'] : domain === 'faq' ? ['faq'] : ['policy'];

        const listIntent = isListIntent(message);
        const altIntent = isAlternativeIntent(message);
        const userWantsBroad = isBroadProductQuery(message);

        // 2) base lock
        const shouldLock = domain === 'product' && !userWantsBroad && !altIntent && !wantUsage && !wantIng;
        let currentProductId = shouldLock ? (productId ?? inferProductIdFromHistory(history) ?? null) : null;

        // 2/b) PRE-LOCK: resolve product from USER MESSAGE (and last assistant) BEFORE retrieval
        if (domain === 'product') {
            let prePid = null;
            // a) URLs in message
            const urlsInMsg = String(message).match(/https?:\/\/\S+/g) || [];
            for (const u of urlsInMsg) { prePid = await robustResolveProductId({ url: u }); if (prePid != null) break; }
            // b) fuzzy names from message
            if (prePid == null) {
                const msgNames = extractProductNameCandidates(message);
                for (const nm of msgNames) { prePid = await robustResolveProductId({ titleGuess: nm }); if (prePid != null) break; }
            }
            // c) last assistant text
            if (prePid == null) {
                const lastAssistantText = [...history].reverse().find(h => h.role === 'assistant')?.content || '';
                const lastNames = extractProductNameCandidates(lastAssistantText);
                for (const nm of lastNames) { prePid = await robustResolveProductId({ titleGuess: nm }); if (prePid != null) break; }
            }
            if (prePid != null) currentProductId = prePid;
        }

        // --- 3) explicit listázás ---
        if (listIntent /* akármi is a domain */) {
            // ha csak magyar kell: [replyLang]; ha minden elérhetőt szeretnél: SUPPORTED_LOCALES
            const items = await listProducts({ locales: [replyLang] });
            if (!items.length) {
                const fallbackMsg =
                    replyLang === 'en' ? 'I could not find products to list. Please specify the product.' :
                        replyLang === 'de' ? 'Ich konnte keine Produkte zum Auflisten finden. Bitte konkretisieren.' :
                            'Nem találtam listázható termékeket. Kérlek pontosítsd, melyik termékre gondolsz.';
                return { reply: fallbackMsg, citations: [], productContext: { currentProductId: null }, replyLang };
            }
            const html = renderProductListHTML(items, replyLang);
            return { reply: html, citations: [...new Set(items.map(it => it.url).filter(Boolean))], productContext: { currentProductId: null }, replyLang };
        }

        // 4) retrieval (with possibly updated currentProductId)
        const expanded = buildExpandedQuery(message, history, { altIntent });
        const qEmb = await (await import('./embeddings.js')).embedQuery(expanded);
        const WANT_K = (wantIng || wantUsage) ? 40 : 18;
        const terms = wantIng ? extractIngredientTerms(message) : [];

        const vecP = retrieveTopChunksMulti(qEmb, { locales, productId: currentProductId, k: WANT_K, docTypes });
        const kwP = wantIng ? fetchKeywordChunks({ productId: currentProductId, locales, docTypes, extraTerms: terms }) : Promise.resolve([]);

        let hits = []; let kw = [];
        const [vecRes, kwRes] = await Promise.allSettled([vecP, kwP]);
        if (vecRes.status === 'fulfilled') hits = vecRes.value || []; else { console.error('[rag] retrieveTopChunksMulti error:', vecRes.reason); hits = []; }
        if (kwRes.status === 'fulfilled') kw = kwRes.value || []; else { console.warn('[rag] fetchKeywordChunks warn:', kwRes.reason); kw = []; }

        if (wantIng && kw.length) {
            const key = (o) => (o.doc_id || '') + '|' + (o.section_title || '') + '|' + (o.metadata?.title || '') + '|' + String(o.content || '').slice(0, 120);
            const map = new Map(); for (const h of [...hits, ...kw]) map.set(key(h), h);
            hits = _prioritizeIngredients([...map.values()], currentProductId).slice(0, WANT_K);
        }

        const bulletCount = (arr) => arr.reduce((n, h) => { const m = String(h.content || '').match(/^\s*[-–•]\s+/gm); return n + (m ? m.length : 0); }, 0);

        if (wantIng && currentProductId != null && bulletCount(hits) < 10) {
            try {
                const wide = await retrieveTopChunksMulti(qEmb, { locales, productId: null, k: WANT_K, docTypes });
                const wideForActive = filterHitsToProduct(wide, currentProductId);
                if (bulletCount(wideForActive) > bulletCount(hits)) hits = wideForActive;
            } catch (e) { console.error('[rag] ingredient wide fallback error:', e); }
        }

        if ((wantUsage || wantIng) && !hits.length) {
            try {
                const wide2 = await retrieveTopChunksMulti(qEmb, { locales, productId: null, k: WANT_K, docTypes: ['policy', 'product', 'faq'] });
                if (wide2?.length) hits = wide2;
            } catch (e) { console.error('[rag] usage/ing wide fallback error:', e); }
        }

        if (!wantIng && !wantUsage && (userWantsBroad || (!hits.length && currentProductId != null))) {
            try { hits = await retrieveTopChunksMulti(qEmb, { locales, productId: null, k: WANT_K, docTypes }); currentProductId = null; }
            catch (e) { console.error('[rag] global fallback error:', e); hits = []; }
        }

        // 5) strict filter for ingredients
        if (wantIng) {
            if (currentProductId != null) {
                hits = filterHitsToProduct(hits, currentProductId);
            } else {
                const guessed = bestPidByBullets(hits);
                if (guessed != null) { hits = filterHitsToProduct(hits, guessed); currentProductId = guessed; }
            }
        }

        if (domain === 'policy' && !hits.length) {
            try {
                hits = await retrieveTopChunksMulti(qEmb, {
                    locales,
                    productId: null,
                    k: 20,
                    docTypes: ['policy']
                });
            } catch (e) {
                console.error('[rag] policy fallback error:', e);
            }
        }

        // 6) no hits
        if (!hits.length) {
            const msg = replyLang === 'en' ? 'No relevant information found. Please specify the product.' : replyLang === 'de' ? 'Keine relevanten Informationen gefunden. Bitte Produkt präzisieren.' : 'Nem találtam releváns információt. Pontosítanád a kérdést (pl. melyik termékre gondolsz)?';
            return { reply: msg, citations: [], productContext: { currentProductId: null }, replyLang };
        }

        // 7) context
        let context = buildContext(hits);
        if (wantIng) {
            const merged = aggregateIngredients(hits, currentProductId);
            if (merged) context += '\n' + merged;
        }

        // 8) LLM
        const trimmedHistory = history.slice(-8);
        const messages = [
            { role: 'system', content: safeSystemPrompt(replyLang) },
            ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
            { role: 'assistant', name: 'context', content: context },
            { role: 'user', content: message }
        ];

        let completion;
        try {
            completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.2, messages });
        } catch (err) {
            console.error('[rag] openai error:', err);
            return { reply: (replyLang === 'en' ? 'Sorry, a technical error occurred.' : replyLang === 'de' ? 'Entschuldigung, ein technischer Fehler ist aufgetreten.' : 'Sajnálom, technikai hiba lépett fel.'), citations: [], productContext: { currentProductId }, replyLang };
        }

        const text = completion?.choices?.[0]?.message?.content ?? (replyLang === 'en' ? 'Please try again.' : replyLang === 'de' ? 'Bitte versuche es erneut.' : 'Kérlek, próbáld újra.');

        let citations = [...new Set(hits.filter(h => h?.locale === replyLang).map(h => h?.metadata?.product_url).filter(Boolean))];
        if (!citations.length) citations = [...new Set(hits.map(h => h?.metadata?.product_url).filter(Boolean))];

        // 9) final productId inference from chunks + reply text
        const inferredFromChunks = domain === 'product' ? safeInferProductIdFromChunks(hits) : null;
        let nextProductId = (domain === 'product' && !userWantsBroad) ? (inferredFromChunks ?? currentProductId ?? null) : null;
        nextProductId = await robustInferProductIdFromReply({ replyText: text, hits, fallbackPid: nextProductId });

        return { reply: text, citations, productContext: { currentProductId: nextProductId ?? null }, replyLang };
    } catch (err) {
        console.error('[rag] top-level error:', err);
        const lang = locale || 'hu';
        const msg = lang === 'en' ? 'Unexpected error during processing. Please try again.' : lang === 'de' ? 'Unerwarteter Fehler bei der Verarbeitung. Bitte versuche es erneut.' : 'Váratlan hiba történt a feldolgozás során. Kérlek próbáld újra.';
        return { reply: msg, citations: [], productContext: { currentProductId: null }, replyLang: locale || 'hu' };
    }
}