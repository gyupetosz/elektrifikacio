// lib/supabaseAdmin.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) missing');
if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
  global: { headers: { 'X-Client-Info': 'elektrifikacio-ingest/0.1.0' } }
});
