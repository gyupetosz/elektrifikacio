#!/usr/bin/env tsx
// scripts/ingest_pdf.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import OpenAI from 'openai';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { config } from 'dotenv';
config({ path: '.env.local' });   // load env from .env.local in project root

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// --- Chunk beállítások ---
const CHUNK_MAX_CHARS = 900;
const CHUNK_OVERLAP = 150;

// OpenAI embedding segédfüggvény
async function embed(text: string) {
    const { data } = await openai.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dim
        input: text
    });
    return data[0].embedding;
}

// Q/A minták felismerése (HU + EN)
const Q_LABEL = /(?:Q(?:uestion)?|Kérdés)\s*[:\-–]/i;
const A_LABEL = /(?:A(?:nswer)?|Válasz)\s*[:\-–]/i;

function normalizeWhitespace(t: string) {
    return t.replace(/\r/g, '')
        .replace(/\t/g, ' ')
        .replace(/[ \u00A0]+/g, ' ')
        .replace(/\u0000/g, '')
        .trim();
}

function extractQAPairs(raw: string) {
    const text = normalizeWhitespace(raw);
    const splitOnQ = new RegExp(`(?:\\n|^)\\s*(?:${Q_LABEL.source})`, 'i');
    const blocks = text.split(splitOnQ).map(s => s.trim()).filter(Boolean);

    const pairs: { q: string; a: string }[] = [];
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

// Szabad szöveg chunkolás
function freeTextChunks(raw: string) {
    const paras = normalizeWhitespace(raw)
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean);

    const splitSentences = (p: string) =>
        p.replace(/\s+/g, ' ')
            .split(/(?<=[\.!?])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ„(0-9])/)
            .map(s => s.trim())
            .filter(Boolean);

    const sentences = paras.flatMap(splitSentences);

    const chunks: string[] = [];
    let buf = '';
    for (const s of sentences) {
        if ((buf + ' ' + s).trim().length <= CHUNK_MAX_CHARS) {
            buf = (buf ? buf + ' ' : '') + s;
        } else {
            if (buf) chunks.push(buf);
            buf = s;
        }
    }
    if (buf) chunks.push(buf);

    // Átfedés
    if (CHUNK_OVERLAP > 0 && chunks.length > 1) {
        const withOverlap: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
            const prevTail = i > 0 ? tail(chunks[i - 1], CHUNK_OVERLAP) : '';
            withOverlap.push((prevTail ? prevTail + ' ' : '') + chunks[i]);
        }
        return withOverlap;
    }
    return chunks;
}

function tail(text: string, take: number) {
    if (text.length <= take) return text;
    return text.slice(text.length - take);
}

// Supabase helper
async function upsertDocument(title: string, virtualPath: string) {
    const { data, error } = await supabaseAdmin
        .from('documents')
        .insert({ title, path: virtualPath })
        .select('*')
        .single();
    if (error) throw error;
    return data;
}

async function insertChunk(document_id: string, chunk_index: number, content: string) {
    const emb = await embed(content);
    const { error } = await supabaseAdmin.from('policy_chunks').insert({
        document_id,
        chunk_index,
        content,
        embedding: emb
    });
    if (error) throw error;
}

// Main
async function main() {
    const file = process.argv[2];
    if (!file || !file.endsWith('.pdf')) {
        console.error('Használat: pnpm tsx scripts/ingest_pdf.ts <file.pdf>');
        process.exit(1);
    }

    const buf = await fs.readFile(path.resolve(file));
    const parsed = await pdf(buf);
    const text = parsed.text || '';

    const doc = await upsertDocument(path.basename(file), file);

    const qa = extractQAPairs(text);
    if (qa.length > 0) {
        let i = 0;
        for (const { q, a } of qa) {
            await insertChunk(doc.id, i++, `Question/Kérdés: ${q}\nAnswer/Válasz: ${a}`);
        }
        console.log(`Uploaded (Q/A): ${qa.length} blocks → document_id=${doc.id}`);
        return;
    }

    const chunks = freeTextChunks(text).filter(c => c.trim().length >= 20);
    let i = 0;
    for (const c of chunks) await insertChunk(doc.id, i++, c);
    console.log(`Uploaded (free text): ${chunks.length} chunks → document_id=${doc.id}`);
}

main().catch(e => { console.error(e); process.exit(1); });
