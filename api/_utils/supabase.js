import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // server-side only
    // KB lives in the dedicated `elektrifikacio` schema inside the shared
    // VitaminBottle project, isolated from its public schema.
    { db: { schema: 'elektrifikacio' } }
);
