#!/usr/bin/env node
// scripts/ingest.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// --- ENV betöltés ('.env.local' majd '.env') ---
const tryLoad = (p) => { try { dotenv.config({ path: p }); } catch { } };
tryLoad(path.resolve(process.cwd(), '.env.local'));
tryLoad(path.resolve(process.cwd(), '.env'));

// --- Supabase + OpenAI ---
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');
if (!SERVICE_ROLE) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- CLI: node scripts/ingest.mjs <folder> [--overwrite]
const FOLDER = process.argv[2] || 'data';
const OVERWRITE = process.argv.includes('--overwrite');

// ===============================
//   LaTeX- és mondat-tudatos CHUNKER (MD/TXT)
// ===============================
const CHUNK_MAX = 900;      // ~600–700 token
const CHUNK_OVERLAP = 120;  // előző chunk vége + aktuális eleje

function normalizeMd(text) {
    return text
        .replace(/\r/g, '')
        .replace(/[ \t]+$/gm, '')       // sorvégi szóközök
        .replace(/\u00A0/g, ' ')        // nem törő szóköz
        .replace(/\n{3,}/g, '\n\n')     // túl sok üres sor
        .trim();
}

// 1) „Védett” egységek kijelölése: $$…$$, $…$, ```…``` és táblák, címsorok
function extractUnits(md) {
    const text = normalizeMd(md);

    const fences = /```[\s\S]*?```/g;         // kódblokkok
    const latexBlock = /\$\$[\s\S]*?\$\$/g;   // $$ … $$
    const latexInline = /\$(?:\\\$|[^\$])+\$/g; // $ … $  (egyszerűsített)
    const tables = /(?:^|\n)(?:\|.+\|\n)+/g;  // md táblák
    const headings = /(^|\n)#{1,6}\s.*(?=\n|$)/g;

    const patterns = [fences, latexBlock, tables, latexInline, headings];

    const ranges = [];
    for (const re of patterns) {
        for (const m of text.matchAll(re)) {
            ranges.push([m.index, m.index + m[0].length]);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);

    const units = [];
    let i = 0;
    const push = (s, type = 'normal') => { if (s && s.trim()) units.push({ type, text: s.trim() }); };

    for (const [s, e] of ranges) {
        if (s > i) push(text.slice(i, s), 'normal');
        push(text.slice(s, e), 'protected');
        i = e;
    }
    if (i < text.length) push(text.slice(i), 'normal');

    // „normal” blokkok finom bontása
    const out = [];
    for (const u of units) {
        if (u.type === 'protected') { out.push(u); continue; }

        const paras = u.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        for (const p of paras) {
            // felsorolásokat egyben hagyjuk
            if (/^[\-\*\●]/m.test(p)) { out.push({ type: 'normal', text: p }); continue; }
            // mondat-szintű bontás (HU/EN heurisztika)
            const sents = p
                .replace(/\s+/g, ' ')
                .split(/(?<=[\.\?\!])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ(0-9])/)
                .map(s => s.trim())
                .filter(Boolean);
            for (const s of sents) out.push({ type: 'normal', text: s });
        }
    }

    return out;
}

function packChunks(units) {
    const chunks = [];
    let buf = '';

    const flush = () => {
        if (!buf) return;
        chunks.push(buf.trim());
        buf = '';
    };

    for (const u of units) {
        const piece = u.text;
        if (piece.length > CHUNK_MAX) {
            // nagy védett egység: önálló chunk
            flush();
            chunks.push(piece);
            continue;
        }
        const candidate = (buf ? buf + '\n' : '') + piece;
        if (candidate.length <= CHUNK_MAX) {
            buf = candidate;
        } else {
            // overlap: az előző chunk utolsó X karaktere menjen az új elejére
            if (buf) {
                const overlap = buf.slice(-CHUNK_OVERLAP);
                chunks.push(buf.trim());
                buf = overlap + '\n' + piece;
            } else {
                chunks.push(piece);
            }
        }
    }
    flush();
    return chunks.filter(c => c.trim().length >= 20);
}

function chunkMarkdownOrText(raw) {
    const units = extractUnits(raw);
    return packChunks(units);
}

// ===============================
//   Embedding + Supabase upsert
// ===============================
async function embed(text) {
    const { data } = await openai.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dim (pgvector-hez passzol)
        input: text
    });
    return data[0].embedding;
}

async function upsertDocument({ pathStr, title }) {
    if (OVERWRITE) {
        // ha ugyanazzal a path/title már van, töröljük (cascade miatt a chunkok is törlődnek)
        await supabase.from('documents').delete().eq('path', pathStr);
    }
    const { data, error } = await supabase
        .from('documents')
        .insert({ path: pathStr, title })
        .select('*')
        .single();
    if (error) throw error;
    return data;
}

async function insertChunk(document_id, idx, content) {
    const embedding = await embed(content);
    const { error } = await supabase.from('policy_chunks').insert({
        document_id,
        chunk_index: idx,
        content,
        embedding
    });
    if (error) throw error;
}

// ===============================
//   Fájl bejárás és ingest
// ===============================
async function ingestFile(fullPath) {
    const raw = await fs.readFile(fullPath, 'utf8');

    // LaTeX- és mondat-tudatos chunkolás
    const chunks = chunkMarkdownOrText(raw);

    const doc = await upsertDocument({
        pathStr: fullPath,
        title: path.basename(fullPath)
    });

    let i = 0;
    for (const c of chunks) {
        await insertChunk(doc.id, i++, c);
    }
    console.log(`✓ Ingested ${path.basename(fullPath)} → ${chunks.length} chunks`);
}

async function main() {
    const abs = path.resolve(FOLDER);
    const entries = await fs.readdir(abs);
    const candidates = entries.filter(f => {
        const n = f.toLowerCase();
        return n.endsWith('.md') || n.endsWith('.txt');
    });

    if (candidates.length === 0) {
        console.log(`No .md/.txt found in: ${abs}`);
        return;
    }

    for (const f of candidates) {
        const full = path.join(abs, f);
        await ingestFile(full);
    }
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
