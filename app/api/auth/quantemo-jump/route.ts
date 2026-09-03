import { NextResponse } from "next/server";
import { getAdminUser } from "@/lib/adminAuth";

export const runtime = "nodejs";

/**
 * "Open Quantemo" — hands the signed-in staff member straight into the
 * Quantemo storefront, already signed in, without a second password prompt.
 *
 * The two apps run on the SAME Supabase project (see lib/quantemo.ts), so
 * it's one identity either side — but they're on different domains, and a
 * Supabase session cookie is domain-scoped, so the session itself can't
 * simply follow the click. A single-use magic link is what bridges that:
 * Supabase mints it for an account, the browser follows it, and Quantemo's
 * own Supabase client picks the session up at the far end.
 *
 * Deliberately NOT done by forwarding this session's access/refresh tokens
 * in the URL — a refresh token is long-lived and would then sit in browser
 * history, the Referer header, and any proxy log along the way. The magic
 * link is single-use and expires on its own.
 *
 * SECURITY: the link is minted for the CALLER'S OWN email, read from their
 * verified server-side session — never from anything in the request. There
 * is no target-user parameter to abuse, so this cannot be used to obtain a
 * sign-in link for somebody else's account. The redirect target is likewise
 * a fixed environment value, not caller input, so it can't be turned into
 * an open redirect. POST rather than GET so a link prefetch can't quietly
 * burn a token.
 */
export async function POST() {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const target = process.env.QUANTEMO_APP_URL;
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.QUANTEMO_SUPABASE_SERVICE_KEY;
  if (!target || !baseUrl || !serviceKey) {
    return NextResponse.json(
      { error: "Quantemo jump is not configured. Set QUANTEMO_APP_URL (see .env.local.example)." },
      { status: 503 },
    );
  }

  // Raw REST rather than the supabase-js admin.generateLink() helper, for
  // the same reason app/api/auth/sync-role does: that SDK path throws an
  // opaque AuthRetryableFetchError against this project, while a plain
  // fetch to the identical endpoint works.
  const res = await fetch(`${baseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: admin.email, redirect_to: target }),
  });

  if (!res.ok) {
    // The response body can carry the service key's own error detail, so it
    // goes to the server log and the caller gets a plain message.
    console.error("Quantemo jump link failed:", res.status, await res.text());
    return NextResponse.json({ error: "Could not open Quantemo. Try again, or sign in there directly." }, { status: 502 });
  }

  const { action_link: actionLink } = (await res.json()) as { action_link?: string };
  if (!actionLink) {
    console.error("Quantemo jump link failed: no action_link in Supabase response");
    return NextResponse.json({ error: "Could not open Quantemo. Try again, or sign in there directly." }, { status: 502 });
  }

  // 303, so the browser follows with a GET instead of re-POSTing to
  // Supabase's verify endpoint. no-store keeps a single-use link out of any
  // cache between here and the tab that asked for it.
  return NextResponse.redirect(actionLink, { status: 303, headers: { "Cache-Control": "no-store" } });
}
