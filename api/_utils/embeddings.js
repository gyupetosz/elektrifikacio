import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedQuery(text) {
    const r = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
    });
    return r.data[0].embedding;
}
