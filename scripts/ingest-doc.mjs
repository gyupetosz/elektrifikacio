// scripts/ingest-doc.mjs
// Usage examples (Windows CMD – egy sorban!):
//   node scripts/ingest-doc.mjs --url "https://example.com/page" --title "My Doc" --product 1011 --locale hu --type product --maxChars 1800 --overlap 350 --overwrite true
//   node scripts/ingest-doc.mjs --file ".\\docs\\faq.pdf"          --title "GENEX GYIK" --product 1011 --locale hu --type faq --maxChars 1800 --overlap 350 --overwrite true
//
// Options:
//   --maxChars N       chunk méret (karakter)
//   --overlap N        chunk átfedés (karakter)
//   --overwrite true   ha létezik a doc: régi chunkok törlése + újraírás
//   --canonUrl true    docs.url mezőbe is kanonikus product URL kerüljön (ha felismerhető)
//   --inferProduct true URL-ből próbálja kinyerni a product ID-t, ha --product nincs
//   --inferLocale true  HTML <html lang=".."> alapján próbálja kinyerni a locale-t, ha nincs megadva
//
// Env kell: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { parse as parseHTML } from 'node-html-parser';
import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
import pdf from 'pdf-parse/lib/pdf-parse.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/* ----------------------------- CLI PARSER ----------------------------- */
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const token = process.argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
        const k = body.slice(0, eq);
        const v = body.slice(eq + 1);
        args[k] = v;
    } else {
        const next = process.argv[i + 1];
        if (next && !next.startsWith('--')) { args[body] = next; i++; }
        else { args[body] = true; }
    }
}

const RAW_URL = args.url || null;
const FILE_PATH = args.file || null;
let TITLE = args.title || null;
let PRODUCT_ID = args.product || null;
let LOCALE = args.locale || 'hu';
const DOC_TYPE = args.type || 'product'; // 'product' | 'faq' | 'policy' | 'snippet'
const MAX_CHARS = Number(args.maxChars || 1200);
const OVERLAP = Number(args.overlap || 200);
const OVERWRITE = String(args.overwrite || 'false').toLowerCase() === 'true';
const CANON_URL_IN_DOC = String(args.canonUrl || 'false').toLowerCase() === 'true';
const INFER_PRODUCT = String(args.inferProduct || 'false').toLowerCase() === 'true';
const INFER_LOCALE = String(args.inferLocale || 'false').toLowerCase() === 'true';

/* ----------------------------- HELPERS ----------------------------- */
function cleanText(s) {
    return (s || '')
        .replace(/\r/g, '')
        .replace(/\t/g, ' ')
        .replace(/[ \u00A0]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// --- Helper: összetevő-jelöltek kigyűjtése egy szekcióból (ul/li + p)
//    Latin név (zárójelben) + opcionális mennyiség mintákra figyelünk.
// --- Helper: összetevők kigyűjtése egy szekcióból
function collectIngredientsFromSection(sectionRoot) {
    if (sectionRoot) return [];

    const seen = new Set();
    const out = [];

    const pushIfLooksIngredient = (raw) => {
        let t = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!t) return;

        const low = t.toLowerCase();
        // tabcímkék / headingek / figyelmeztetések tiltólista
        const blacklist = [
            'leírás', 'leiras', 'összetevők', 'osszetevok', 'videó', 'video',
            'termékünk összetevői', 'összetevői és előnyeik', 'használat',
            'adagolás', 'javasolt napi adag', 'vitamin/ásványi információ',
            'figyelem', 'videó', 'video'
        ];
        if (blacklist.some(x => low.includes(x))) return;

        // végéről : – — - le
        t = t.replace(/\s*[:–—-]\s*$/, '');

        // rövid, cím-szerű (ne legyen mondatzáró)
        const looksTitley = t.length <= 120 && !/[.!?]$/.test(t);

        // minták (maradhatnak a nem-bold elemekhez)
        const latinRe = /\(([A-Z][a-z]+(?:\s+[a-z]+){1,3})\)/;
        const qtyRe = /\b\d{1,4}(?:[.,]\d+)?\s?(?:mg|g|µg|mcg|ml|mL|%|capszula|db|pcs)\b(?:\s*\/\s*\d{1,4}\s?(?:ml|mL|capszula|db|pcs))?/i;
        const kwRe = /\b(kivonat|extract|olaj|oil|por|powder|mag|seed|gyökér|root|levél|leaf|kéreg|bark|vitamin|mineral|egcg|allicin|berberin|kurkumin|kurkuminoid|kvercetin|rezveratrol|glutation|glutathion|máriatövis|mariatövis|mariatovis|nigella|feketekömény)\b/i;

        const key = t.toLowerCase();
        if (!seen.has(key)) {
            // Bold címkéknél már elég a rövid, címszerű forma
            if (looksTitley) {
                seen.add(key); out.push(t); return;
            }
            // sima szövegnél csak akkor, ha van latin/mennyiség/kulcsszó
            if (latinRe.test(t) || qtyRe.test(t) || kwRe.test(t)) {
                seen.add(key); out.push(t); return;
            }
        }
    };

    // 0) MINDEN <strong>/<b> külön elemként (itt vannak a hatóanyagcímkék)
    sectionRoot.querySelectorAll('strong,b').forEach(el => {
        const txt = (el.textContent || '').trim();
        if (!txt) return;
        // kizárjuk a nagyon hosszú / mondatszerű félkövér részeket
        if (txt.length <= 120 && !/[.!?]$/.test(txt)) {
            // kifejezetten szűrjük a gyakori ál-fejezeteket
            const bad = /^(figyelem|javasolt napi adag|leírás|összetevők)\b/i;
            if (!bad.test(txt)) pushIfLooksIngredient(txt);
        }
    });

    // 1) UL/OL LI + bullet-P + "Név: ..." sorok
    sectionRoot.querySelectorAll('ul li, ol li, p').forEach(el => {
        const html = el.innerHTML || '';

        // sor eleji félkövér (ha valamiért a 0. passzban kimaradt)
        const head = html.match(/^(?:\s*<(?:strong|b)>)([^<]+?)(?:<\/(?:strong|b)>)/i);
        if (head) { pushIfLooksIngredient(head[1]); return; }

        const txt = (el.textContent || '').trim();

        // csak cím + kettőspont/gondolatjel esetén
        const nameHead = txt.match(/^(.{2,120}?)[\s]*[:–—-]\s+/);
        if (nameHead) { pushIfLooksIngredient(nameHead[1]); return; }

        // csak bullet-szerű sor
        const bullet = txt.match(/^\s*[-–•*]\s*(.+)/);
        if (bullet) { pushIfLooksIngredient(bullet[1]); return; }
    });

    // 2) táblázatok
    sectionRoot.querySelectorAll('table tr').forEach(tr => {
        const cells = tr.querySelectorAll('th,td')
            .map(c => (c.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        if (!cells.length) return;
        if (cells.length >= 2) {
            const left = cells[0], right = cells[1];
            if (/\d/.test(right)) pushIfLooksIngredient(`${left} ${right}`);
            else { pushIfLooksIngredient(left); pushIfLooksIngredient(right); }
        } else {
            pushIfLooksIngredient(cells[0]);
        }
    });

    // --- UTÓSZŰRŐ: dobjuk a "A/Az ..." kezdetű, nem-bold, nem-mennyiséges sorokat
    return out.filter(line => {
        const s = line.trim();
        if (/^(a|az)\s/i.test(s)) return false;        // “A … / Az …”
        if (/vitaminokat tartalmaz/i.test(s)) return false;
        return true;
    });
}

// --- Segéd: GPT-vel próbáljuk kinyerni az összetevőlistát, ha a hagyományos módszer nem talált semmit
async function gptExtractIngredients(text) {
    try {
        const prompt = `
Szedd ki az alábbi termékleírásból az összetevőket rövid bulletpont listaként.
Csak az összetevők nevét add vissza, mennyiséggel együtt ha van.
Más szöveget NE írj ki.

TERMÉKSZÖVEG:
${text}
    `;

        const r = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Te egy adatkinyerő asszisztens vagy.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0
        });

        const out = r.choices[0].message.content.trim();
        if (!out) return null;

        // mindig `- ` kezdetű sorokra normalizáljuk
        return out
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => (s.startsWith('-') ? s : `- ${s}`))
            .join('\n');
    } catch (e) {
        console.error('⚠️ GPT extract error', e);
        return null;
    }
}

// [CHANGE] view-source_https___... → normál URL
function normalizeWeirdViewSourceUrl(u) {
    if (!u) return u;
    let s = String(u);
    if (!/^view-source_/.test(s)) return s;
    // pl.: view-source_https___genex-mission.com_produktdetails_1011_0_xxx.html
    s = s.replace(/^view-source_/, '');
    s = s.replace('___', '://');
    s = s.replace(/_/g, '/');
    // Dupla / takarítás, de hagyjuk meg a ://-t
    s = s.replace(/([^:])\/\/+/g, '$1/');
    return s;
}

// [CHANGE] Minimal copy of productIdFromUrl so we can standardize URLs here as well.
function productIdFromUrl(u) {
    const s = String(u || '');
    const m = s.match(/\/(?:produktdetails|product|products|termek|termekek)\/(\d+)(?:\/|$)/i);
    return m ? Number(m[1]) : null;
}

// [CHANGE] Canonicalize product URLs we store into chunk metadata so downstream code has stable links.
function standardizeProductUrl(url) {
    const pid = productIdFromUrl(url);
    if (!pid) return url || null;
    // language- & slug-agnostic, stabil alappal
    return `https://genex-mission.com/en/produktdetails/${pid}`;
}

// [CHANGE] egyszerű retry/backoff fetch
async function fetchWithRetries(url, opts = {}, tries = 3, baseDelayMs = 500) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url, {
                headers: {
                    'User-Agent': 'RAG-Ingest/1.1 (+https://vercel.com/)',
                    'Accept': 'text/html,application/pdf;q=0.9,*/*;q=0.8',
                    ...opts.headers
                },
                ...opts
            });
            if (!r.ok) throw new Error(`Fetch failed ${r.status} ${r.statusText}`);
            return r;
        } catch (e) {
            lastErr = e;
            if (i < tries - 1) {
                await new Promise(res => setTimeout(res, baseDelayMs * Math.pow(2, i)));
            }
        }
    }
    throw lastErr;
}

// --- htmlToRichText: csak a Leírás + Összetevők tab, és az összetevőkből TISZTA bulletlista készül
function htmlToRichText(body) {
    const root = parseHTML(body);
    const ingPane = root.querySelector('#top-profile');
    const descPane = root.querySelector('#top-home');
    const scope = (ingPane || descPane)
        ? parseHTML(
            (descPane ? `<section id="__desc__"><h2>Leírás</h2>${descPane.innerHTML}</section>` : '') +
            (ingPane ? `<section id="__ing__"><h2>Összetevők</h2>${ingPane.innerHTML}</section>` : '')
        )
        : root;

    // …(zaj kiszedése, <p> normalizálás maradhat)…

    let names = [];
    const ingSec = scope.querySelector('#__ing__');
    if (ingSec) {
        names = collectIngredientsFromSection(ingSec);
        if (names.length) {
            const bullets = names.map(n => `- ${n}`);
            ingSec.set_content(`***ING_LIST_START***\n${bullets.join('\n')}\n***ING_LIST_END***\n`);
            console.log(`🧪 Összetevők tab: ${names.length} tétel`);
        }
    }

    if (!names.length) {
        const descSec = scope.querySelector('#__desc__');
        const auto = collectIngredientsFromSection(descSec);
        if (auto.length) {
            names = auto;
            const bullets = names.map(n => `- ${n}`).join('\n');
            const tail = descSec.innerHTML || '';
            descSec.set_content(`${tail}\n***ING_LIST_START***\n${bullets}\n***ING_LIST_END***\n`);
            console.log(`🧪 Leírásból kinyerve: ${names.length} tétel`);
        }
    }

    // …(táblák → TSV, végső tisztítás maradhat)…

    let out = scope.textContent
        .replace(/\r/g, '')
        .replace(/\t/g, ' ')
        .replace(/[ \u00A0]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .filter(l => {
            const t = l.trim().replace(/^#{1,6}\s*/, '').replace(/^[-–•*]\s*/, '').toLowerCase();
            return !['leírás', 'leiras', 'összetevők', 'osszetevok', 'videó', 'video', 'description', 'ingredients'].includes(t);
        })
        .join('\n')
        .trim();

    return out;
}

// Összetevők kinyerése a richText-ből (explicit markerrel)
function extractIngredientsSections(richText) {
    const text = richText;
    const START = '***ING_LIST_START***';
    const END = '***ING_LIST_END***';

    const si = text.indexOf(START);
    const ei = text.indexOf(END, si + START.length);

    let listLines = [];
    if (si !== -1 && ei !== -1) {
        const block = text.substring(si + START.length, ei).trim();
        listLines = block
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => s.startsWith('- ') ? s : `- ${s}`);
    }

    const uniq = arr => [...new Set(arr.map(s => s.trim()))];
    return {
        listText: listLines.length ? uniq(listLines).join('\n') : null,
        detailsText: null
    };
}

// --- readFromUrl: csak a Leírás + Összetevők tabot adjuk tovább a normalizálónak
async function readFromUrl(url) {
    const r = await fetchWithRetries(url);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());

    if (ct.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
        const { text } = await pdf(buf);
        return { text: cleanText(text), htmlTitle: null, metaDesc: null, ogTitle: null, richText: cleanText(text), htmlLang: null };
    }

    let body = buf.toString('utf8');
    const isHtml = ct.includes('html') || /^<!doctype html>/i.test(body);
    if (!isHtml) {
        const t = cleanText(body);
        return { text: t, htmlTitle: null, metaDesc: null, ogTitle: null, richText: t, htmlLang: null };
    }

    const root = parseHTML(body);
    const htmlTitle = root.querySelector('title')?.textContent?.trim() || null;
    const ogTitle = root.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || null;
    const metaDesc = root.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || null;
    const htmlLang = root.querySelector('html')?.getAttribute('lang')?.trim() || null;

    const ing = root.querySelector('#top-profile');
    const desc = root.querySelector('#top-home');
    if (ing || desc) {
        let scopedHtml = '';
        if (desc) scopedHtml += desc.toString();
        if (ing) scopedHtml += ing.toString();
        body = scopedHtml;
    }

    const richText = htmlToRichText(body);
    const text = cleanText(richText);
    return { text, htmlTitle, metaDesc, ogTitle, richText, htmlLang };
}

async function readFromFile(fpRaw) {
    const fp = path.resolve(fpRaw);
    if (!fs.existsSync(fp)) throw new Error(`File not found: ${fp}`);
    const ext = path.extname(fp).toLowerCase();
    const buf = fs.readFileSync(fp);
    if (ext === '.pdf') {
        const { text } = await pdf(buf);
        const t = cleanText(text);
        return { text: t, richText: t, htmlTitle: null, metaDesc: null, ogTitle: null, htmlLang: null };
    }
    const t = cleanText(buf.toString('utf8'));
    return { text: t, richText: t, htmlTitle: null, metaDesc: null, ogTitle: null, htmlLang: null };
}

async function embedAll(texts) {
    const r = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts
    });
    return r.data.map(d => d.embedding);
}

// sliding-window chunking
function chunkText(text, maxChars = 1200, overlap = 200) {
    const t = text.trim();
    if (t.length <= maxChars) return [t];
    const chunks = [];
    let i = 0;
    while (i < t.length) {
        const end = Math.min(i + maxChars, t.length);
        chunks.push(t.slice(i, end));
        if (end === t.length) break;
        i = Math.max(0, end - overlap);
    }
    return chunks;
}

/* ----------------------------- MAIN ----------------------------- */
async function main() {
    if (!RAW_URL && !FILE_PATH) {
        console.error('Provide one of: --url or --file');
        process.exit(1);
    }
    if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing required env var(s): OPENAI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
        process.exit(1);
    }

    // [CHANGE] URL normalizálás (view-source_https___... → normál)
    const SOURCE_URL = RAW_URL ? normalizeWeirdViewSourceUrl(RAW_URL) : null;

    // 0) beolvasás
    let rawText, richText, meta = { htmlTitle: null, metaDesc: null, ogTitle: null, htmlLang: null };
    if (SOURCE_URL) {
        const r = await readFromUrl(SOURCE_URL);
        rawText = r.text;
        richText = r.richText;
        meta = r;
        if (!TITLE) TITLE = r.ogTitle || r.htmlTitle || r.metaDesc || SOURCE_URL;
    } else {
        const r = await readFromFile(FILE_PATH);
        rawText = r.text;
        richText = r.richText;
        meta = r;
        if (!TITLE) TITLE = path.basename(path.resolve(FILE_PATH));
    }

    if (!rawText || rawText.length < 10) throw new Error('Empty/too short document text');

    // [CHANGE] locale becslés HTML-ből (ha kérted és nincs explicit megadva)
    if (INFER_LOCALE && (!args.locale || args.locale === 'hu') && meta.htmlLang) {
        LOCALE = meta.htmlLang.toLowerCase().slice(0, 2);
    }

    // [CHANGE] product ID becslés URL-ből (ha kérted és nincs explicit megadva)
    if (INFER_PRODUCT && !PRODUCT_ID && SOURCE_URL) {
        const pid = productIdFromUrl(SOURCE_URL);
        if (pid) PRODUCT_ID = pid;
    }

    // 1) meglévő doc?
    let existing = null;
    if (SOURCE_URL) {
        const matchUrl = CANON_URL_IN_DOC ? standardizeProductUrl(SOURCE_URL) : SOURCE_URL;
        const { data: exByUrl, error: exErr } = await supabase
            .from('docs').select('doc_id').eq('url', matchUrl).maybeSingle();
        if (exErr) throw exErr;
        existing = exByUrl;
    }
    if (!existing && TITLE) {
        const { data: exByTitle, error: ex2Err } = await supabase
            .from('docs').select('doc_id').eq('title', TITLE).maybeSingle();
        if (ex2Err) throw ex2Err;
        existing = exByTitle;
    }

    // 2) doc létrehozás / felülírás
    let docId;
    const urlForDocs = SOURCE_URL
        ? (CANON_URL_IN_DOC ? standardizeProductUrl(SOURCE_URL) : SOURCE_URL)
        : null;

    if (existing && !OVERWRITE) {
        docId = existing.doc_id;
        console.log(`ℹ️  Reusing existing doc: ${docId}`);
    } else if (existing && OVERWRITE) {
        console.log(`♻️  Overwrite requested; deleting old chunks for doc ${existing.doc_id}`);
        const { error: delErr } = await supabase.from('chunks').delete().eq('doc_id', existing.doc_id);
        if (delErr) throw delErr;
        const { error: updErr } = await supabase
            .from('docs')
            .update({
                product_id: PRODUCT_ID,
                locale: LOCALE,
                doc_type: DOC_TYPE,
                url: urlForDocs, // [CHANGE] frissítjük az URL-t (kanonikus opció szerint)
                updated_at: new Date().toISOString()
            })
            .eq('doc_id', existing.doc_id);
        if (updErr) throw updErr;
        docId = existing.doc_id;
    } else {
        const { data: doc, error: docErr } = await supabase
            .from('docs')
            .insert({
                source: SOURCE_URL ? 'url' : 'file',
                locale: LOCALE,
                title: TITLE,
                url: urlForDocs, // [CHANGE] opcionálisan kanonikus azonnal
                doc_type: DOC_TYPE,
                product_id: PRODUCT_ID
            })
            .select('doc_id')
            .single();
        if (docErr) throw docErr;
        docId = doc.doc_id;
        console.log(`✅ Created doc: ${docId}`);
    }

    // 3/a) Összetevők – KÜLÖN, tiszta bulletlista-chunk
    let listText = null, detailsText = null;
    if (DOC_TYPE === 'product') {
        ({ listText, detailsText } = extractIngredientsSections(richText || rawText));

        // Ha nincs listText → próbáljuk GPT-vel
        if (!listText) {
            console.log('🤖 GPT-hez fordulunk összetevő kinyeréshez...');
            listText = await gptExtractIngredients(rawText);
        }
    }
    const specialChunks = [];
    if (listText) {
        specialChunks.push({
            section_title: 'Összetevők – lista',
            metadata: { subtype: 'ingredients_list' },
            content:
                `Title: ${TITLE}
Source: ${SOURCE_URL || path.resolve(FILE_PATH)}
Locale: ${LOCALE}

### Összetevők (lista)
${listText}`
        });

        // [ÚJ] kiírjuk a konzolra az összetevőket
        console.log('\n🥦 Kinyert összetevők:');
        listText.split('\n').forEach(line => {
            console.log(' ', line.replace(/^- /, '').trim());
        });
    }
    if (detailsText) {
        specialChunks.push({
            section_title: 'Összetevők – részletek',
            metadata: { subtype: 'ingredients_details' },
            content:
                `Title: ${TITLE}
Source: ${SOURCE_URL || path.resolve(FILE_PATH)}
Locale: ${LOCALE}

### Összetevők – részletes leírás
${detailsText}`
        });
    }

    // 3/b) Általános chunkolás (teljes szöveg)
    const chunks = chunkText(rawText, MAX_CHARS, OVERLAP);
    const packed = chunks.map((c, i) => ({
        section_title: `Szakasz ${i + 1}`,
        metadata: {},
        content:
            `Title: ${TITLE}
Source: ${SOURCE_URL || path.resolve(FILE_PATH)}
Locale: ${LOCALE}

${c}`
    }));

    const allPacked = [...specialChunks, ...packed];

    console.log(`🧩 ${allPacked.length} chunks (size=${MAX_CHARS}, overlap=${OVERLAP})` +
        (specialChunks.length ? ` | +${specialChunks.length} speciális összetevő chunk` : '')
    );

    // 4) embed
    const vectors = await embedAll(allPacked.map(p => p.content));

    // [CHANGE] Előállítjuk a kanonikus (standardizált) product_url-t a meta számára.
    const CANON_URL = SOURCE_URL ? standardizeProductUrl(SOURCE_URL) : null;

    // 5) insert chunks
    const rows = allPacked.map((p, i) => ({
        doc_id: docId,
        product_id: PRODUCT_ID,
        locale: LOCALE,
        doc_type: DOC_TYPE,
        section_title: p.section_title,
        content: p.content,
        metadata: {
            title: TITLE,
            // [CHANGE] A meta.product_url mindig kanonikus legyen, hogy a chat oldalon stabilan működjön az URL → PID.
            product_url: CANON_URL,
            source: SOURCE_URL ? 'url' : 'file',
            file: SOURCE_URL ? null : path.basename(path.resolve(FILE_PATH)),
            meta_desc: meta.metaDesc,
            html_title: meta.htmlTitle,
            og_title: meta.ogTitle,
            ...(p.metadata || {})
        },
        embedding: vectors[i]
    }));

    const { error: chErr } = await supabase.from('chunks').insert(rows);
    if (chErr) throw chErr;

    console.log(`🎉 Ingest complete: ${rows.length} chunks → doc ${docId}`);
}

main().catch(e => {
    console.error('❌ Ingest failed:', e);
    process.exit(1);
});
