#!/usr/bin/env node
// scripts/ingest_pdf.mjs
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

// ENV
const tryLoad = (p) => { try { dotenv.config({ path: p }); } catch { } };
tryLoad(path.resolve(process.cwd(), '.env.local'));
tryLoad(path.resolve(process.cwd(), '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!SERVICE_ROLE) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// CLI: node scripts/ingest_pdf.mjs <file-or-folder> [--overwrite]
const TARGET = process.argv[2];
const OVERWRITE = process.argv.includes('--overwrite');
if (!TARGET) {
    console.error('Usage: node scripts/ingest_pdf.mjs <file.pdf | folder> [--overwrite]');
    process.exit(1);
}

// Chunking
const CHUNK_MAX = 900;
const OVERLAP = 150;

async function embed(text) {
    const { data } = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
    });
    return data[0].embedding;
}

const Q_LABEL = /(?:Q(?:uestion)?|Kérdés)\s*[:\-–]/i;
const A_LABEL = /(?:A(?:nswer)?|Válasz)\s*[:\-–]/i;

function norm(t) {
    return t.replace(/\r/g, '').replace(/\t/g, ' ')
        .replace(/[ \u00A0]+/g, ' ').replace(/\u0000/g, '').trim();
}

function extractNumberedQAPairs(textRaw) {
    const text = norm(textRaw);
    // Matches blocks like:
    // "12. Mit … ?" → (captures the question)
    //  ...answer lines until the next "N. Something?" or end of text
    const re = /(?:^|\n)\s*\d+\.\s+(.+?\?)\s*\n([\s\S]*?)(?=(?:\n\s*\d+\.\s+.+?\?)|$)/g;
    const pairs = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        const q = m[1].trim();
        const a = m[2].trim();
        if (q && a) pairs.push({ q, a });
    }
    return pairs;
}
function extractQAPairs(textRaw) {
    const text = norm(textRaw);
    const splitOnQ = new RegExp(`(?:\\n|^)\\s*(?:${Q_LABEL.source})`, 'i');
    const blocks = text.split(splitOnQ).map(s => s.trim()).filter(Boolean);
    const pairs = [];
    for (const b of blocks) {
        const aRegex = new RegExp(`(.+?)(?:\\n\\s*(?:${A_LABEL.source})\\s*)([\\s\\S]+)`, 'i');
        const m = b.match(aRegex);
        if (m) {
            const q = m[1].trim();
            let a = m[2].trim();
            const nextQ = new RegExp(`\\n\\s*(?:${Q_LABEL.source})`, 'i');
            a = a.split(nextQ)[0].trim();
            if (q && a) pairs.push({ q, a });
        }
    }
    return pairs;
}

function charChunks(textRaw, maxLen = 900, overlap = 150) {
    // Keep newlines/spaces; only normalize Windows newlines.
    const text = String(textRaw).replace(/\r/g, '');
    const chunks = [];
    const step = Math.max(1, maxLen - overlap);
    let start = 0;

    while (start < text.length) {
        const end = Math.min(text.length, start + maxLen);
        chunks.push(text.slice(start, end));
        start += step;
    }
    return chunks;
}

async function upsertDocument({ title, pathStr }) {
    if (OVERWRITE) {
        await supabase.from('documents').delete().eq('path', pathStr);
    }
    const { data, error } = await supabase
        .from('documents').insert({ title, path: pathStr })
        .select('*').single();
    if (error) throw error;
    return data;
}

async function insertChunk(document_id, idx, content) {
    const emb = await embed(content);
    const { error } = await supabase.from('policy_chunks').insert({
        document_id, chunk_index: idx, content, embedding: emb
    });
    if (error) throw error;
    if (idx % 10 === 0) console.log(`… inserted chunk #${idx}`);
}

async function ingestPdfFile(filePath) {
    const buf = await fs.readFile(path.resolve(filePath));
    const parsed = await pdf(buf);
    const text = typeof parsed.text === 'string' ? parsed.text : '';

    const doc = await upsertDocument({
        title: path.basename(filePath),
        pathStr: filePath
    });

    // Always chunk the full text; do not try to extract Q/A.
    const chunks = charChunks(text, CHUNK_MAX, OVERLAP);

    console.log(`Chunking "${path.basename(filePath)}" → ${chunks.length} chunks`);

    let i = 0;
    for (const c of chunks) {
        await insertChunk(doc.id, i++, c);
    }

    console.log(`✓ PDF full text: ${path.basename(filePath)} → ${chunks.length} chunks`);
}

async function main() {
    const abs = path.resolve(TARGET);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
        const all = (await fs.readdir(abs)).filter(f => f.toLowerCase().endsWith('.pdf'));
        if (all.length === 0) { console.log('No PDFs found in folder'); return; }
        for (const f of all) await ingestPdfFile(path.join(abs, f));
    } else {
        if (!abs.toLowerCase().endsWith('.pdf')) {
            console.error('Please pass a .pdf file or a folder containing PDFs.');
            process.exit(1);
        }
        await ingestPdfFile(abs);
    }
    console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
