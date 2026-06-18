// A/B test: baseline RAG vs. the smarter pipeline, same questions, live DB.
// Baseline = all improvements off (old behaviour). Improved = rag_config defaults.
// Hybrid + MMR + embedding-dedup fully activate only after sql/smarter_rag.sql
// is applied; until then they degrade gracefully (rerank + follow-up still work).
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
const { askPolicyRag } = await import('../api/_utils/rag.js');

const BASELINE = {
  RAG_USE_HYBRID: false, RAG_USE_DEDUP: false, RAG_USE_RERANK: false,
  RAG_USE_MMR: false, RAG_CONDENSE_HISTORY: false, RAG_DEBUG: true,
};
const IMPROVED = { RAG_DEBUG: true };

const clip = (s, n = 320) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const hr = (c = '─') => console.log(c.repeat(82));

async function run(label, q, history, cfg) {
  const t0 = Date.now();
  const r = await askPolicyRag({ query: q, history, cfg });
  const ms = Date.now() - t0;
  const sims = (r.sources || []).map(s => s.similarity?.toFixed(2)).filter(Boolean).join(',');
  console.log(`\n[${label}]  ${ms}ms | ${r.sources?.length ?? 0} sources${sims ? ` | sims ${sims}` : ''}`);
  if (r.standalone && r.standalone !== q) console.log(`  rewritten→ "${r.standalone}"`);
  if (r.debug) console.log(`  mode: ${r.debug.mode} | stages: ${JSON.stringify(r.debug.stages)}`);
  console.log(`  A: ${clip(r.answer, 420)}`);
}

const SINGLES = [
  'Mi a különbség a BEV, a PHEV és a REx között?',
  'Mennyi idő alatt tölt fel egy 60 kWh-s akkumulátort egy 11 kW-os AC töltő 20%-ról 80%-ra?',
  'Mi a különbség az AC és a DC töltés között, és melyik olcsóbb?',
];

(async () => {
  console.log('\n================  SINGLE-QUESTION A/B  ================');
  for (const q of SINGLES) {
    hr('═'); console.log(`Q: ${q}`);
    await run('BASELINE', q, [], BASELINE);
    await run('IMPROVED', q, [], IMPROVED);
  }

  console.log('\n\n================  FOLLOW-UP (conversation memory)  ================');
  // Turn 1 establishes context.
  const t1 = 'Mi az a BEV?';
  const a1 = await askPolicyRag({ query: t1, history: [], cfg: IMPROVED });
  console.log(`\nTurn 1 Q: ${t1}\nTurn 1 A: ${clip(a1.answer, 240)}`);
  const history = [{ role: 'user', content: t1 }, { role: 'assistant', content: a1.answer }];

  // Turn 2 is a follow-up whose meaning depends on turn 1 ("az" = BEV).
  const t2 = 'És az mennyivel drágább, mint egy hagyományos autó?';
  hr('═'); console.log(`Follow-up Q: ${t2}`);
  await run('BASELINE (no memory)', t2, [], BASELINE);
  await run('IMPROVED (with memory)', t2, history, IMPROVED);
})().catch(e => { console.error('HARNESS FAILED:', e); process.exit(1); });
