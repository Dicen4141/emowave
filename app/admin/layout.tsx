"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isAuthPath } from "@/lib/authPaths";

const LINKS = [
  { href: "/admin/workspace", label: "EmoSpace" },
  { href: "/admin/facts", label: "Manage Facts" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Whose session this is. Shown next to Sign out so it's obvious which
  // account you're about to drop — this tool gets shared between staff. Also
  // whether to show the Reference Data link — hiding it for a regular admin
  // is a UX nicety, not the real gate (the API route enforces superadmin on
  // its own regardless of what the nav shows).
  useEffect(() => {
    let active = true;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!active) return;
        setEmail(data.user?.email ?? null);
        setIsSuperadmin(data.user?.app_metadata?.role === "superadmin");
      })
      // A failure here only costs the email label; the nav still works, and
      // the middleware is what actually enforces the session.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pathname]);

  async function handleSignOut() {
    setSigningOut(true);
    await createClient().auth.signOut();
    // replace(), not push() — going "back" into a dead session would just get
    // bounced by the middleware anyway. refresh() clears cached server data
    // for the signed-out user rather than leaving it in the router cache.
    router.replace("/admin/login");
    router.refresh();
  }

  // Login and set-password live under /admin, so they inherit this layout —
  // but nobody on them is signed in yet, and offering nav links to pages the
  // middleware will bounce them straight back from is just a dead end.
  if (isAuthPath(pathname)) return <>{children}</>;

  return (
    <div>
      <nav className="admin-nav">
        <Link href="/admin" className="brand">
          <span className="brand-dot" aria-hidden="true" />
          EmoWave Admin
        </Link>
        {[...LINKS, ...(isSuperadmin ? [{ href: "/admin/reference-data", label: "Reference Data" }] : [])].map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="nav-link"
            // /admin is a prefix of every other route, so it only counts as
            // current on an exact match — otherwise all four highlight at once.
            aria-current={pathname === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
        <div className="nav-right">
          {/* A form POST, not a <Link> or <a> — the route it hits mints a
              single-use sign-in link, and a GET would let the browser (or
              Next's own prefetch) burn one without anybody clicking. Opens
              in a new tab so the EmoSpace you were mid-task in survives. */}
          <form action="/api/auth/quantemo-jump" method="post" target="_blank" className="nav-jump">
            <button type="submit" className="nav-link" title="Open Quantemo, signed in as this account">
              Quantemo ↗
            </button>
          </form>
          {email && <span className="nav-user">{email}</span>}
          <button type="button" className="btn-secondary nav-signout" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </nav>
      {children}
    </div>
  );
}
