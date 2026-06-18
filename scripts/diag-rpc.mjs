import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
const { supabase } = await import('../api/_utils/supabase.js');
const { embedQuery } = await import('../api/_utils/embeddings.js');

const qvec = await embedQuery('AC és DC töltés különbsége');

console.log('--- match_policy_chunks_hybrid ---');
let r = await supabase.rpc('match_policy_chunks_hybrid', {
  query_text: 'AC és DC töltés', query_embedding: qvec, match_count: 3, min_content_length: 20,
});
if (r.error) console.log('ERROR:', r.error.message, '| code', r.error.code);
else console.log('rows:', r.data.length, '| keys:', Object.keys(r.data[0] || {}).join(','),
  '| embedding present?', r.data[0]?.embedding != null);

console.log('--- match_policy_chunks ---');
r = await supabase.rpc('match_policy_chunks', { query_embedding: qvec, match_count: 3, min_content_length: 20 });
if (r.error) console.log('ERROR:', r.error.message, '| code', r.error.code);
else console.log('rows:', r.data.length, '| keys:', Object.keys(r.data[0] || {}).join(','),
  '| embedding present?', r.data[0]?.embedding != null);
