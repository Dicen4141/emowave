/**
 * Who counts as an admin.
 *
 * Role lives in Supabase Auth's app_metadata — NOT user_metadata, which the
 * signed-in user could edit themselves via updateUser(). app_metadata can only
 * be set server-side with the service-role key (see scripts/create-admin.mjs),
 * so a regular admin can never grant themselves superadmin.
 *
 * Kept as a pure predicate with no imports so all three callers can share it:
 * middleware (edge), lib/adminAuth.ts (server), and the login form (browser).
 * Before this existed the same two-way comparison was written out in each of
 * them, which is exactly the kind of check you don't want drifting.
 */
export type AdminRole = "admin" | "superadmin";

export function isAdminRole(role: unknown): role is AdminRole {
  return role === "admin" || role === "superadmin";
}
