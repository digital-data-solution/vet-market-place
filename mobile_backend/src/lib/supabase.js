import { createClient } from '@supabase/supabase-js';

const supabaseUrl        = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('⚠️  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — creating stubbed client for tests');
}

let supabaseAdmin;
if (supabaseUrl && supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession:   false,
    },
  });
} else {
  // Minimal stub so importing modules won't crash in test environments without env vars
  supabaseAdmin = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };
}

export { supabaseAdmin };

export const verifySupabaseToken = async (token) => {
  try {
    if (!supabaseAdmin || !supabaseAdmin.auth || typeof supabaseAdmin.auth.getUser !== 'function') {
      return null;
    }
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error) throw error;
    return user;
  } catch (error) {
    console.error('Token verification failed:', error.message || error);
    return null;
  }
};