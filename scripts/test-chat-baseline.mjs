// Baseline I/O test for the elektrifikacio chat (askPolicyRag).
// Loads .env.local, verifies the KB has data, then runs a set of
// representative questions end-to-end and prints answers + retrieval info.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// Import AFTER env is loaded (supabase client reads env at module load).
const { supabase } = await import('../api/_utils/supabase.js');
const { askPolicyRag } = await import('../api/_utils/rag.js');

const QUERIES = [
  'Mi a különbség a BEV, a PHEV és a REx között?',                       // factual, in KB
  'Mennyi idő alatt tölt fel egy 60 kWh-s akkumulátort egy 11 kW-os AC töltő 20%-ról 80%-ra?', // calculation, in KB
  'Mi a különbség az AC és a DC töltés között, és melyik olcsóbb?',      // factual, in KB
  'Megéri-e használt elektromos autót venni? Mire figyeljek?',          // synthesis, in KB
  'És mennyibe kerül egy margarita pizza?',                              // out-of-scope -> fallback
];

function hr() { console.log('─'.repeat(80)); }

(async () => {
  // 1) Sanity: does the KB have data?
  const { count: docCount } = await supabase.from('documents').select('*', { count: 'exact', head: true });
  const { count: chunkCount } = await supabase.from('policy_chunks').select('*', { count: 'exact', head: true });
  console.log(`KB contents: documents=${docCount ?? 'ERR'}, policy_chunks=${chunkCount ?? 'ERR'}`);
  hr();

  // 2) Run each query and report.
  for (const q of QUERIES) {
    const t0 = Date.now();
    let res;
    try {
      res = await askPolicyRag({ query: q });
    } catch (e) {
      console.log(`Q: ${q}\nERROR (${e.step || 'n/a'}): ${e.message}`);
      hr();
      continue;
    }
    const ms = Date.now() - t0;
    const sims = (res.sources || []).map(s => s.similarity?.toFixed(3)).join(', ');
    console.log(`Q: ${q}`);
    console.log(`A: ${res.answer}`);
    console.log(`   [${ms} ms | ${res.sources?.length ?? 0} sources | sims: ${sims || 'none'}]`);
    hr();
  }
})().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(1); });
