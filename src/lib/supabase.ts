import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://fyxywsocbfcnbprlknfp.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_j4psJxTD4_GifcIWhoFHvg_YINJGDPH';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
