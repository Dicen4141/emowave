import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// For use in Server Components / Route Handlers — reads the session from
// the incoming request's cookies. Must be created fresh per-request (not
// cached as a singleton like lib/db.ts's Prisma client).
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component — middleware refreshes the
            // session instead, so this is safe to ignore here.
          }
        },
      },
    },
  );
}
