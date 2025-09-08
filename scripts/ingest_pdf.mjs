#!/usr/bin/env node
// scripts/ingest_pdf.mjs
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import pdf from 'pdf-parse';
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

function freeTextChunks(textRaw) {
    const paras = norm(textRaw).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const splitSentences = (p) =>
        p.replace(/\s+/g, ' ')
            .split(/(?<=[\.!?])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ„(0-9])/)
            .map(s => s.trim()).filter(Boolean);
    const sents = paras.flatMap(splitSentences);

    const chunks = [];
    let buf = '';
    for (const s of sents) {
        if ((buf ? buf + ' ' : '').concat(s).length <= CHUNK_MAX) {
            buf = (buf ? buf + ' ' : '') + s;
        } else {
            if (buf) chunks.push(buf);
            buf = s;
        }
    }
    if (buf) chunks.push(buf);

    if (OVERLAP > 0 && chunks.length > 1) {
        const withOverlap = [];
        for (let i = 0; i < chunks.length; i++) {
            const prevTail = i > 0 ? chunks[i - 1].slice(-OVERLAP) : '';
            withOverlap.push((prevTail ? prevTail + ' ' : '') + chunks[i]);
        }
        return withOverlap;
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
}

async function ingestPdfFile(filePath) {
    const buf = await fs.readFile(path.resolve(filePath));
    const parsed = await pdf(buf);
    const text = parsed.text || '';

    const doc = await upsertDocument({
        title: path.basename(filePath),
        pathStr: filePath
    });

    const qa = extractQAPairs(text);
    if (qa.length > 0) {
        let i = 0;
        for (const { q, a } of qa) {
            await insertChunk(doc.id, i++, `Question/Kérdés: ${q}\nAnswer/Válasz: ${a}`);
        }
        console.log(`✓ PDF Q/A: ${path.basename(filePath)} → ${qa.length} blocks`);
        return;
    }

    const chunks = freeTextChunks(text).filter(c => c.trim().length >= 20);
    let i = 0; for (const c of chunks) await insertChunk(doc.id, i++, c);
    console.log(`✓ PDF free text: ${path.basename(filePath)} → ${chunks.length} chunks`);
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
