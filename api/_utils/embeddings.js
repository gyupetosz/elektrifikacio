import OpenAI from 'openai';
import { RAG_CONFIG } from './rag_config.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const EMBEDDING_MODEL = RAG_CONFIG.EMBEDDING_MODEL;
export const EMBEDDING_DIM = 1536; // 3-small és ada-002 is 1536, de a terek NEM kompatibilisek!

export async function embedQuery(text) {
    const input = typeof text === 'string' ? text : String(text ?? '');
    const r = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input,
    });
    return r.data[0].embedding;
}
