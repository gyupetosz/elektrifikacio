// Migrate elektrifikacio KB (`documents` + `policy_chunks`, embeddings included)
// from the OLD Supabase project to the NEW shared project. Uses the REST API
// (no psql needed). Re-runnable: rows are upserted on their primary key.
//
// Run the elektrifikacio schema on the NEW project first (sql/schema.sql), then:
//   OLD_SUPABASE_URL=... OLD_SUPABASE_SERVICE_ROLE_KEY=... \
//   NEW_SUPABASE_URL=... NEW_SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/migrate-elektrifikacio.mjs
import { createClient } from '@supabase/supabase-js';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
  return v;
};

// OLD project: tables live in `public`. NEW project: tables live in the
// dedicated `elektrifikacio` schema (alongside VitaminBottle's public schema).
const old = createClient(need('OLD_SUPABASE_URL'), need('OLD_SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});
const neu = createClient(need('NEW_SUPABASE_URL'), need('NEW_SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
  db: { schema: 'elektrifikacio' },
});

const PAGE = 500;
const BATCH = 50;

async function readAll(client, table, orderCol) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select('*')
      .order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function writeAll(client, table, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await client.from(table).upsert(rows.slice(i, i + BATCH), { defaultToNull: false });
    if (error) throw new Error(`write ${table} [${i}..]: ${error.message}`);
    process.stdout.write(`  ${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  if (rows.length) process.stdout.write('\n');
}

(async () => {
  // Order by `id`: present on both tables (old policy_chunks has no created_at).
  console.log('Reading documents from OLD…');
  const documents = await readAll(old, 'documents', 'id');
  console.log(`  ${documents.length} documents`);

  console.log('Reading policy_chunks from OLD…');
  const chunks = await readAll(old, 'policy_chunks', 'id');
  console.log(`  ${chunks.length} policy_chunks`);

  console.log('Writing documents to NEW…');
  await writeAll(neu, 'documents', documents);        // parents first (FK)
  console.log('Writing policy_chunks to NEW…');
  await writeAll(neu, 'policy_chunks', chunks);

  const { count: dCount } = await neu.from('documents').select('*', { count: 'exact', head: true });
  const { count: cCount } = await neu.from('policy_chunks').select('*', { count: 'exact', head: true });
  console.log(`\nDone. NEW project: documents=${dCount}, policy_chunks=${cCount} (expected ${documents.length}/${chunks.length}).`);
})().catch((e) => { console.error('\nMIGRATION FAILED:', e.message); process.exit(1); });
