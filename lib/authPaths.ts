/**
 * The only routes reachable without a signed-in admin session.
 *
 * Shared rather than listed twice: middleware.ts uses it to decide what to let
 * through, and app/admin/layout.tsx uses it to hide the admin nav. Those two
 * lists drifting apart is how you end up with a login screen that offers links
 * to the pages you aren't signed in for.
 *
 * No server imports here — middleware runs on the edge runtime.
 */
export const AUTH_PATHS = ["/admin/login", "/admin/set-password"] as const;

export function isAuthPath(pathname: string): boolean {
  return (AUTH_PATHS as readonly string[]).includes(pathname);
}
