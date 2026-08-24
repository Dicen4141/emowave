import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAuthPath } from "@/lib/authPaths";
import { isAdminRole } from "@/lib/adminRole";

// Every page and API route in this app is EmoWave's internal admin tool —
// there is no public-facing route — so everything under /admin and /api is
// gated behind a signed-in Supabase Auth session with an admin/superadmin
// role in app_metadata (see lib/adminAuth.ts for how that role is read
// elsewhere; role can't be self-granted since app_metadata is only settable
// server-side with the service-role key — see scripts/create-admin.mjs).
// The public list lives in lib/authPaths.ts because the admin layout needs
// the same answer to know when to hide its nav.

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Never trust getSession() here — getUser() actually revalidates the
  // token against Supabase instead of just trusting whatever cookie showed up.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublicPath = isAuthPath(path);
  const isAuthedAdmin = !!user && isAdminRole(user.app_metadata?.role);

  // Any signed-in Quantemo user can hit this one specifically — it's what
  // GRANTS the admin role in the first place (see app/api/auth/sync-role),
  // so requiring the role already be set here would make it unreachable for
  // exactly the person it exists for. The route itself only ever acts on
  // the caller's own account, so this isn't a wider hole than that.
  const isSelfServeSync = path === "/api/auth/sync-role";
  if (isSelfServeSync) {
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      return NextResponse.redirect(url);
    }
    return response;
  }

  // Server-to-server call from Quantemo's Supabase Database Webhook — no
  // EmoWave session exists for this at all, by nature. Authenticated
  // entirely by the shared secret checked inside the route itself instead.
  if (path === "/api/webhooks/quantemo-order") {
    return response;
  }

  if (!isAuthedAdmin && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    return NextResponse.redirect(url);
  }

  if (isAuthedAdmin && path === "/admin/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/workspace";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/:path*"],
};
