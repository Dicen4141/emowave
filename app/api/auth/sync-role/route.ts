import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { lookupQuantemoRole } from "@/lib/quantemo";
import { isAdminRole } from "@/lib/adminRole";

export const runtime = "nodejs";

// Called right after sign-in (see app/admin/login/page.tsx) — bridges
// Quantemo's own role column to EmoWave's admin/superadmin gate, so anyone
// Quantemo already has marked "admin" gets EmoWave admin access
// automatically on their next login, instead of needing a manual
// scripts/create-admin.mjs run for every person. Only ever grants "admin",
// never "superadmin" — Quantemo's role enum has no superadmin distinction,
// and that tier stays a deliberately small, manually-curated set. Acts on
// the CALLER's own session only (never takes a target user as input), so
// there's no way to use this to grant access to someone else.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Already has an EmoWave role — never downgrade a superadmin to admin,
  // and no need to re-grant an existing admin.
  if (isAdminRole(user.app_metadata?.role)) {
    return NextResponse.json({ role: user.app_metadata.role });
  }

  const quantemoRole = await lookupQuantemoRole(user.email);
  if (quantemoRole !== "admin") {
    return NextResponse.json({ role: user.app_metadata?.role ?? null });
  }

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!baseUrl || !serviceKey) return NextResponse.json({ role: user.app_metadata?.role ?? null });

  // Raw REST, not the @supabase/supabase-js admin.updateUserById() helper —
  // that SDK method throws an opaque AuthRetryableFetchError on this
  // project (confirmed while building scripts/create-admin.mjs); a plain
  // fetch against the same endpoint works fine.
  const res = await fetch(`${baseUrl}/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_metadata: { ...user.app_metadata, role: "admin" } }),
  });
  if (!res.ok) {
    console.error("Quantemo -> EmoWave role sync failed:", await res.text());
    return NextResponse.json({ role: user.app_metadata?.role ?? null });
  }

  return NextResponse.json({ role: "admin" });
}
