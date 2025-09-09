import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
}

// Server-side client (service role)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});