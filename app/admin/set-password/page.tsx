"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Landing page for the link in a Supabase invite/reset email
// (scripts/create-admin.mjs). The Supabase browser client reads the
// token out of the URL itself and establishes a session before this
// component ever renders — so this page just needs to let that session's
// user pick their real password.
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [linkValid, setLinkValid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        setError("This link is invalid or has expired — ask a superadmin to send a new invite.");
      }
      setLinkValid(!!data.user);
      setReady(true);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setSubmitting(false);
      setError(updateError.message);
      return;
    }
    // Kept disabled through the redirect rather than flicking back to "Save".
    router.replace("/admin/workspace");
    router.refresh();
  }

  if (!ready) return null;

  return (
    <div className="auth-screen">
      <form onSubmit={handleSubmit} className="card auth-card" aria-busy={submitting}>
        <div className="auth-brand">
          <span className="brand-dot" aria-hidden="true" />
          EmoWave Admin
        </div>

        <h1 className="auth-title">Set your password</h1>
        <p className="auth-sub">
          {linkValid ? "Pick a password for your admin account — at least 8 characters." : "This invite can't be used."}
        </p>

        {/* A dead link leaves nothing useful to submit, so the fields are
            dropped entirely rather than shown and rejected on submit. */}
        {linkValid && (
          <>
            <label className="auth-field">
              New password
              <span className="auth-password">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoFocus
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  aria-describedby={error ? "setpw-error" : undefined}
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

            <label className="auth-field">
              Confirm password
              <input
                type={showPassword ? "text" : "password"}
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
              />
            </label>
          </>
        )}

        {error && (
          <p className="error auth-error" id="setpw-error" role="alert">
            {error}
          </p>
        )}

        {linkValid ? (
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save password"}
          </button>
        ) : (
          <a href="/admin/login" className="auth-foot">
            Back to sign in
          </a>
        )}
      </form>
    </div>
  );
}
