import { createBrowserClient } from "@supabase/ssr";

// For use in "use client" components — reads/writes the session via cookies.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
