import { NextResponse } from "next/server";
import { sendReportReadyEmail } from "@/lib/email";

export const runtime = "nodejs";

// Temporary — lets you confirm the Resend setup actually works end-to-end
// before it's wired into the real report-ready flow. Not linked from any
// page; call it directly. Safe to delete once the real trigger exists.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const to = typeof body.to === "string" ? body.to : null;
  if (!to) {
    return NextResponse.json({ error: "Provide `to` (an email address) in the request body." }, { status: 400 });
  }

  const result = await sendReportReadyEmail(to, "Test User", "https://example.com/report/test-token");
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
