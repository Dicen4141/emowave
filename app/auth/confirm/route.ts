import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { syncQuantemoRole } from "@/lib/syncRole";
import { isAdminRole } from "@/lib/adminRole";

export const runtime = "nodejs";

/**
 * Landing point for the "Open EmoWave" jump from Quantemo — the mirror of
 * app/api/auth/quantemo-jump, which sends staff the other way.
 *
 * Quantemo mints a single-use magic link for the caller's own account (both
 * apps share one Supabase project, so it's one identity either side) and
 * sends the browser here with its token_hash. Redeeming it with verifyOtp is
 * what writes this domain's session cookies — a Supabase cookie is
 * domain-scoped, so the session itself can't follow the click across domains.
 *
 * Why token_hash rather than following Supabase's own action_link: that link
 * ends at whatever redirect_to it was minted with, dropping the session in a
 * URL fragment for a browser-side client to pick up. This app reads its
 * session from cookies via @supabase/ssr, and a fragment never reaches the
 * server — so the token has to be redeemed HERE, server-side, instead.
 *
 * NOT under the middleware matcher (/admin, /api), which is what lets an
 * as-yet-unauthenticated request reach it. That's safe: the token_hash is
 * single-use, expires on its own, and is only ever minted by Quantemo for the
 * account of the person who clicked. An invalid or replayed one simply fails
 * verifyOtp and lands on the login form.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = (url.searchParams.get("type") ?? "magiclink") as EmailOtpType;

  // RELATIVE Location, deliberately — never an absolute URL built from this
  // request. Behind DigitalOcean's proxy the host Next.js sees in a Node
  // runtime route handler is the container's own bind address, so anything
  // derived from it (`url.origin`, and `url.clone()` too) sends the browser to
  // https://localhost:8080/... — verified twice against the deployed app.
  // A relative Location sidesteps the question: the browser resolves it
  // against the URL it actually requested, which is the public one. Dropping
  // the query string is what keeps the single-use token_hash out of the
  // address bar and browser history.
  const goTo = (path: string) =>
    new NextResponse(null, {
      status: 303,
      headers: { Location: path, "Cache-Control": "no-store" },
    });

  // Every failure ends at the normal login form rather than an error page —
  // signing in by hand is always a valid way out of a broken jump. The reason
  // rides along as a query param for support to read off the address bar.
  const bounce = (reason: string) => goTo(`/admin/login?sso=${reason}`);

  if (!tokenHash) return bounce("missing");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error || !data.user) {
    console.error("EmoWave SSO confirm failed:", error?.message ?? "no user in verifyOtp response");
    return bounce("invalid");
  }

  // Same bridge the password login runs: a Quantemo admin who has never
  // signed in here yet gets the EmoWave role granted on the way through.
  const role = isAdminRole(data.user.app_metadata?.role)
    ? data.user.app_metadata.role
    : await syncQuantemoRole(data.user);

  // A real Supabase user without the admin role would otherwise be redirected
  // to /admin/workspace, bounced straight back by the middleware, and left
  // staring at a login form that appears to have done nothing. Sign them out
  // so the session can't linger — mirrors app/admin/login/page.tsx.
  if (!isAdminRole(role)) {
    await supabase.auth.signOut();
    return bounce("norole");
  }

  return goTo("/admin/workspace");
}
