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
if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!SERVICE_ROLE) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- CLI: node scripts/ingest.mjs <folder> [--overwrite]
const FOLDER = process.argv[2] || 'data';
const OVERWRITE = process.argv.includes('--overwrite');

// --- Chunk beállítások ---
const CHUNK_SIZE = 800;      // chars
const CHUNK_OVERLAP = 150;   // chars (átfedés)

async function embed(text) {
    const { data } = await openai.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dim (pgvector tábládhoz passzol)
        input: text
    });
    return data[0].embedding;
}

function chunkText(text) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.max(i + CHUNK_SIZE, i + 1);
        const piece = text.slice(i, Math.min(end, text.length));
        if (piece.trim().length) chunks.push(piece);
        i += CHUNK_SIZE - CHUNK_OVERLAP;
        if (i <= 0) i = end; // safety
    }
    return chunks;
}

async function upsertDocument({ pathStr, title }) {
    if (OVERWRITE) {
        // ha ugyanazzal a path/title már van, töröljük (cascade miatt a chunkok is mennek)
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

async function ingestFile(fullPath) {
    const raw = await fs.readFile(fullPath, 'utf8');
    const chunks = chunkText(raw);
    const doc = await upsertDocument({
        pathStr: fullPath,
        title: path.basename(fullPath)
    });
    let i = 0;
    for (const c of chunks) await insertChunk(doc.id, i++, c);
    console.log(`✓ Ingested ${path.basename(fullPath)} → ${chunks.length} chunks`);
}

async function main() {
    const abs = path.resolve(FOLDER);
    const files = await fs.readdir(abs);
    const candidates = files.filter(f => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.txt'));
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
