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
 * GRANTS ONLY — this never takes access away. Quantemo can raise someone to
 * admin, and raise an existing admin to superadmin, but clearing
 * is_super_admin (or dropping them as an admin entirely) leaves whatever they
 * already hold in EmoWave untouched. Revoking is a deliberate manual step:
 * scripts/create-admin.mjs, or editing app_metadata directly.
 *
 * That asymmetry is the point. A sync that could revoke turns every Quantemo
 * data problem into an EmoWave lockout — a mistyped flag, a half-finished
 * migration, an email that no longer matches — and it would do it to the
 * people best placed to fix it. Granting wrongly costs a manual downgrade;
 * revoking wrongly costs everyone their tool. Access therefore only ever moves
 * UP here, and the only way down is by hand.
 *
 * Acts on the account handed in (always the CALLER'S OWN, read from a verified
 * session — never a target taken from request input), so this can't be used to
 * grant access to somebody else.
 *
 * Shared by the two places a session can begin: app/api/auth/sync-role (the
 * password login) and app/auth/confirm (the jump in from Quantemo). It runs at
 * SIGN-IN only, so a change made in Quantemo reaches someone on their next
 * sign-in, not mid-session.
 */
export async function syncQuantemoRole(user: {
  id: string;
  email?: string | null;
  app_metadata?: { role?: unknown } & Record<string, unknown>;
}): Promise<AdminRole | null> {
  const existing: AdminRole | null = isAdminRole(user.app_metadata?.role) ? user.app_metadata.role : null;
  // superadmin is the ceiling, so nothing below can improve on it — skip the
  // lookup entirely rather than fetch an answer that cannot be acted on.
  if (existing === "superadmin") return existing;
  if (!user.email) return existing;

  const result = await lookupQuantemoAccess(user.email);
  // A failed lookup says nothing about the person, so it cannot be the reason
  // anyone gains a tier. (It cannot cost them one either — nothing here ever
  // lowers a role.)
  if (!result.ok) return existing;

  const target: AdminRole | null = result.access?.isSuperAdmin
    ? "superadmin"
    : result.access?.role === "admin"
      ? "admin"
      : null;

  // Only ever move UP the ladder: (none) -> admin -> superadmin. A `target`
  // that is null or no higher than what they hold means Quantemo has nothing
  // to add, NOT that anything should be taken away — an admin Quantemo no
  // longer lists keeps their role until someone removes it by hand.
  const rank = (role: AdminRole | null) => (role === "superadmin" ? 2 : role === "admin" ? 1 : 0);
  if (rank(target) <= rank(existing)) return existing;

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
