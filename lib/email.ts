import { Resend } from "resend";

// Same lazy-init pattern as lib/gemini.ts — the app should still boot and
// every other feature should still work if this key isn't set yet; only
// actually sending an email fails, with a clear reason, not a crash.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Must be an address on a domain you've verified in the Resend dashboard —
// see the Domains step in setup. Sending will fail until that's done.
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || "EmoWave <reports@yourdomain.com>";

export async function sendReportReadyEmail(
  to: string,
  recipientName: string,
  reportUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!resend) {
    console.error("RESEND_API_KEY not set — email not sent.");
    return { ok: false, error: "Email service not configured (missing RESEND_API_KEY)." };
  }

  try {
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject: "Your EmoWave report is ready",
      html: `
        <p>Hi ${recipientName},</p>
        <p>Your report is ready to view:</p>
        <p><a href="${reportUrl}">${reportUrl}</a></p>
        <p>— EmoWave</p>
      `,
    });
    if (error) {
      console.error("Resend send failed:", error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.error("Resend send failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
