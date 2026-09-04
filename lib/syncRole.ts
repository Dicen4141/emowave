import { lookupQuantemoRole } from "@/lib/quantemo";
import { isAdminRole, type AdminRole } from "@/lib/adminRole";

/**
 * Bridge Quantemo's own role column to EmoWave's admin gate: anyone Quantemo
 * already marks "admin" gets EmoWave admin access automatically, instead of
 * needing a manual scripts/create-admin.mjs run per person.
 *
 * Only ever grants "admin", never "superadmin" — Quantemo's role enum has no
 * superadmin distinction, and that tier stays a deliberately small, manually
 * curated set. Acts on the account handed in (always the CALLER'S OWN, read
 * from a verified session — never a target taken from request input), so this
 * can't be used to grant access to somebody else.
 *
 * Shared by the two places a session can begin: app/api/auth/sync-role (the
 * password login) and app/auth/confirm (the jump in from Quantemo).
 */
export async function syncQuantemoRole(user: {
  id: string;
  email?: string | null;
  app_metadata?: { role?: unknown } & Record<string, unknown>;
}): Promise<AdminRole | null> {
  const existing = user.app_metadata?.role;
  // Already has an EmoWave role — never downgrade a superadmin to admin, and
  // no need to re-grant an existing admin.
  if (isAdminRole(existing)) return existing;
  if (!user.email) return null;

  if ((await lookupQuantemoRole(user.email)) !== "admin") return null;

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!baseUrl || !serviceKey) return null;

  // Raw REST rather than the supabase-js admin.updateUserById() helper — that
  // SDK method throws an opaque AuthRetryableFetchError on this project
  // (confirmed while building scripts/create-admin.mjs); a plain fetch against
  // the identical endpoint works fine.
  const res = await fetch(`${baseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_metadata: { ...user.app_metadata, role: "admin" } }),
  });
  if (!res.ok) {
    console.error("Quantemo -> EmoWave role sync failed:", await res.text());
    return null;
  }
  return "admin";
}
