"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isAdminRole } from "@/lib/adminRole";

// Supabase's own wording for a bad email/password is "Invalid login
// credentials", which reads like the form itself is broken. Anything not
// listed here is shown verbatim — guessing at unknown failures would hide
// real ones (rate limits, network, a misconfigured project).
const FRIENDLY_ERRORS: Record<string, string> = {
  "Invalid login credentials": "That email and password don't match an account.",
  "Email not confirmed": "This account hasn't confirmed its email address yet.",
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setSubmitting(false);
      setError(FRIENDLY_ERRORS[signInError.message] ?? signInError.message);
      return;
    }

    // Bridges Quantemo's own role column ("admin") to EmoWave's, in case
    // this account was just promoted there and hasn't logged in since — see
    // app/api/auth/sync-role. A no-op for anyone who already has an EmoWave
    // role, or whose Quantemo role isn't "admin". Best-effort: falls back to
    // whatever role the sign-in response already carried if the sync call
    // itself fails, rather than blocking login on it.
    let role = data.user?.app_metadata?.role;
    try {
      const syncRes = await fetch("/api/auth/sync-role", { method: "POST" });
      if (syncRes.ok) role = (await syncRes.json()).role ?? role;
    } catch {
      // best-effort, see above
    }

    // Signing in successfully is not the same as being allowed in. A real
    // Supabase user without the admin role would otherwise be redirected to
    // /admin/workspace, bounced back here by the middleware, and left staring
    // at a login form that appears to have silently done nothing. Sign them
    // back out so the session can't linger, and say why.
    if (!isAdminRole(role)) {
      await supabase.auth.signOut();
      setSubmitting(false);
      setError("This account doesn't have admin access.");
      return;
    }

    // No setSubmitting(false) on success — the button stays disabled through
    // the redirect rather than flicking back to "Sign in" mid-navigation.
    router.replace("/admin/workspace");
    router.refresh();
  }

  return (
    <div className="auth-screen">
      <form onSubmit={handleSubmit} className="card auth-card" aria-busy={submitting}>
        <div className="auth-brand">
          <span className="brand-dot" aria-hidden="true" />
          EmoWave Admin
        </div>

        <h1 className="auth-title">Sign in</h1>
        <p className="auth-sub">Internal tool — admin accounts only.</p>

        <label className="auth-field">
          Email
          <input
            type="email"
            required
            autoFocus
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={error ? true : undefined}
          />
        </label>

        <label className="auth-field">
          Password
          <span className="auth-password">
            <input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "login-error" : undefined}
            />
            <button
              type="button"
              className="auth-reveal"
              onClick={() => setShowPassword((v) => !v)}
              disabled={submitting}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </span>
        </label>

        {error && (
          <p className="error auth-error" id="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>

        <p className="auth-foot">Lost access? Ask a superadmin to reset your account.</p>
      </form>
    </div>
  );
}
