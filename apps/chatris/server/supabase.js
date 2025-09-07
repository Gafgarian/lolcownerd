import { createClient } from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL && process.env.SUPABASE_URL.trim();

const key =
  (process.env.SUPABASE_SERVICE_KEY && process.env.SUPABASE_SERVICE_KEY.trim()) ||
  (process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_ANON_KEY.trim());

if (!url) throw new Error('Missing SUPABASE_URL env var');
if (!key) throw new Error('Missing SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) env var');

export const supa = createClient(url, key);
