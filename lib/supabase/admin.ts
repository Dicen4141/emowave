import { createClient } from "@supabase/supabase-js";

// Service-role client for managing EmoWave admin/superadmin accounts via
// Supabase Auth's Admin API (inviting users, setting their role). Reuses
// QUANTEMO_SUPABASE_SERVICE_KEY since it's already a service-role key for
// this SAME Supabase project (see lib/quantemo.ts) — there's no separate
// admin-user-management project to point at. Server-only: never expose this
// to the browser.
let cachedClient: ReturnType<typeof createClient> | null = null;
export function supabaseAdmin() {
  if (cachedClient) return cachedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or QUANTEMO_SUPABASE_SERVICE_KEY.");
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}
