#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import OpenAI from 'openai';
import { config } from 'dotenv';
config({ path: '.env.local' });   // load env from .env.local in project root

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });


const INPUT_DIR = process.argv[2] || 'data';
const CHUNK_SIZE = 800; // chars
const CHUNK_OVERLAP = 150; // chars


async function embed(text: string) {
    const { data } = await openai.embeddings.create({
        model: 'text-embedding-3-small', // 1536 dims
        input: text
    });
    return data[0].embedding;
}


function chunkText(text: string) {
    const chunks: string[] = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + CHUNK_SIZE, text.length);
        const piece = text.slice(i, end);
        chunks.push(piece);
        i += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks;
}


async function upsertDocument(filePath: string, title?: string) {
    const { data: doc, error } = await supabaseAdmin
        .from('documents')
        .insert({ path: filePath, title })
        .select('*')
        .single();
    if (error) throw error;
    return doc;
}


async function upsertChunks(document_id: string, chunks: string[]) {
    let idx = 0;
    for (const content of chunks) {
        const embedding = await embed(content);
        const { error } = await supabaseAdmin.from('policy_chunks').insert({
            document_id,
            chunk_index: idx++,
            content,
            embedding
        });
        if (error) throw error;
    }
}


async function main() {
    const abs = path.resolve(INPUT_DIR);
    const files = await fs.readdir(abs);
    for (const f of files) {
        if (!f.endsWith('.md') && !f.endsWith('.txt')) continue;
        const full = path.join(abs, f);
        const raw = await fs.readFile(full, 'utf8');
        const chunks = chunkText(raw).filter(c => c.trim().length > 0);
        const doc = await upsertDocument(full, path.basename(f));
        await upsertChunks(doc.id, chunks);
        console.log(`Ingested ${f} → ${chunks.length} chunks`);
    }
}


main().catch((e) => { console.error(e); process.exit(1); });