import { createClient } from "@/lib/supabase/server";
import { isAdminRole, type AdminRole } from "@/lib/adminRole";

export type { AdminRole };
export type AdminUser = { id: string; email: string; role: AdminRole };

// Role lives in Supabase Auth's app_metadata — NOT user_metadata, which the
// signed-in user could edit themselves via updateUser(). app_metadata can
// only be set server-side with the service-role key (see scripts/create-admin.mjs),
// so a regular admin can never grant themselves superadmin.
export async function getAdminUser(): Promise<AdminUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;
  const role = user.app_metadata?.role;
  if (!isAdminRole(role)) return null;
  return { id: user.id, email: user.email, role };
}
