import { lookupQuantemoAccess } from "@/lib/quantemo";
import { isAdminRole, type AdminRole } from "@/lib/adminRole";

/**
 * Bridge Quantemo's access model to EmoWave's admin gate, so staff get the
 * matching EmoWave tier automatically instead of needing a manual
 * scripts/create-admin.mjs run per person.
 *
 * Quantemo splits access across TWO columns, and both matter here:
 *   role = "admin"        -> EmoWave "admin"
 *   is_super_admin = true -> EmoWave "superadmin"
 * Every Quantemo super admin also carries role="admin", so the flag narrows
 * that group rather than replacing it. An earlier version of this read only
 * `role`, which cannot tell the two apart — so every person arriving from
 * Quantemo landed as plain "admin" and the superadmin-only screens (Reference
 * Data, new-client creation, order import) stayed invisible to them no matter
 * what Quantemo said they were.
 *
 * Acts on the account handed in (always the CALLER'S OWN, read from a verified
 * session — never a target taken from request input), so this can't be used to
 * grant access to somebody else.
 *
 * Shared by the two places a session can begin: app/api/auth/sync-role (the
 * password login) and app/auth/confirm (the jump in from Quantemo).
 */
export async function syncQuantemoRole(user: {
  id: string;
  email?: string | null;
  app_metadata?: { role?: unknown } & Record<string, unknown>;
}): Promise<AdminRole | null> {
  const existing: AdminRole | null = isAdminRole(user.app_metadata?.role) ? user.app_metadata.role : null;
  // Nothing below can improve on the top tier, so don't spend a lookup on it.
  // This is also what guarantees a hand-granted superadmin (create-admin.mjs)
  // survives a jump-in from a Quantemo account that isn't flagged.
  if (existing === "superadmin") return existing;
  if (!user.email) return existing;

  const access = await lookupQuantemoAccess(user.email);
  const target: AdminRole | null = access?.isSuperAdmin ? "superadmin" : access?.role === "admin" ? "admin" : null;

  // Only ever move UP. `target` being null (or merely equal) means Quantemo has
  // nothing to add — it must not strip an EmoWave role that was granted here,
  // by hand or on an earlier sync.
  if (!target || target === existing) return existing;

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  // `existing`, not null, on every failure path below — this function's caller
  // signs the user out when it returns a non-admin role, so answering null for
  // a misconfigured env or a flaky write would lock out an admin who already
  // had access, turning a failed UPGRADE into a lockout.
  if (!baseUrl || !serviceKey) return existing;

  // Raw REST rather than the supabase-js admin.updateUserById() helper — that
  // SDK method throws an opaque AuthRetryableFetchError on this project
  // (confirmed while building scripts/create-admin.mjs); a plain fetch against
  // the identical endpoint works fine.
  const res = await fetch(`${baseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_metadata: { ...user.app_metadata, role: target } }),
  });
  if (!res.ok) {
    console.error("Quantemo -> EmoWave role sync failed:", await res.text());
    return existing;
  }
  return target;
}
