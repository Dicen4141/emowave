import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncQuantemoRole } from "@/lib/syncRole";

export const runtime = "nodejs";

// Called right after sign-in (see app/admin/login/page.tsx) — bridges
// Quantemo's own role column to EmoWave's admin/superadmin gate, so anyone
// Quantemo already has marked "admin" gets EmoWave admin access
// automatically on their next login, instead of needing a manual
// scripts/create-admin.mjs run for every person. The grant itself lives in
// lib/syncRole.ts, shared with app/auth/confirm (the jump in from Quantemo,
// which begins a session without ever touching this login form).
//
// Acts on the CALLER's own session only (never takes a target user as
// input), so there's no way to use this to grant access to someone else.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const role = await syncQuantemoRole(user);
  return NextResponse.json({ role: role ?? user.app_metadata?.role ?? null });
}
