import 'dotenv/config';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- Replace/extend with real data later
const PRODUCT = {
  product_id: '1011',
  locale: 'hu',
  title: 'GENEX Immuno Spike Detox LIGHT – Tüske Fehérje Detox kapszula (60 db)',
  url: 'https://genex-mission.com/produktdetails/1011/0/genex-immuno-spike-detox-light-tuske-feherje-detox-kapszula-60-db',
  doc_type: 'product',
  sections: [
    {
      section_title: 'Ár és link',
      content: `Ár: 69,00 EUR
Link: <a href="https://genex-mission.com/produktdetails/1011/0/genex-immuno-spike-detox-light-tuske-feherje-detox-kapszula-60-db">Itt megtalálod</a>`
    },
    {
      section_title: 'Részletes leírás',
      content: `A GENEX Immuno Spike Detox LIGHT kapszula ... (ide tedd a teljes leírást).`
    },
    {
      section_title: 'Használat',
      content: `- Napi 1 kapszula
- Glutén-, laktózmentes, vegetáriánusok és vegánok is fogyaszthatják
- Nem tartalmaz adalékanyagokat, tartósítószert vagy mesterséges összetevőket`
    }
  ]
};

// very simple chunker (~1200 chars per chunk)
function chunkText(text, maxChars = 1200) {
  const parts = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + '\n\n' + p).length > maxChars) {
      if (buf) out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function embedAll(texts) {
  const r = await openai.embeddings.create({
    model: 'text-embedding-3-small', // 1536 dims
    input: texts
  });
  return r.data.map(d => d.embedding);
}

async function run() {
  // insert doc
  const { data: doc, error: docErr } = await supabase
    .from('docs')
    .insert({
      source: 'manual',
      locale: PRODUCT.locale,
      title: PRODUCT.title,
      url: PRODUCT.url,
      doc_type: PRODUCT.doc_type,
      product_id: PRODUCT.product_id
    })
    .select('doc_id')
    .single();
  if (docErr) throw docErr;

  // build chunk texts with breadcrumbs
  const chunkTexts = [];
  for (const s of PRODUCT.sections) {
    for (const c of chunkText(s.content)) {
      const text = `Product: ${PRODUCT.title}
Section: ${s.section_title}
Locale: ${PRODUCT.locale}

${c}`;
      chunkTexts.push({ section_title: s.section_title, text });
    }
  }

  // embed + insert
  const vectors = await embedAll(chunkTexts.map(x => x.text));
  const rows = chunkTexts.map((x, i) => ({
    doc_id: doc.doc_id,
    product_id: PRODUCT.product_id,
    locale: PRODUCT.locale,
    doc_type: PRODUCT.doc_type,
    section_title: x.section_title,
    content: x.text,
    metadata: { title: PRODUCT.title, product_url: PRODUCT.url },
    embedding: vectors[i]
  }));

  const { error: chErr } = await supabase.from('chunks').insert(rows);
  if (chErr) throw chErr;

  console.log(`Inserted ${rows.length} chunks for product ${PRODUCT.product_id}`);
}

run().catch(e => { console.error(e); process.exit(1); });
