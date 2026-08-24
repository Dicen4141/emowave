import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { renderReportChatHtml } from "@/lib/renderReportPdf";

// Node runtime (uses the Prisma client, not available on the Edge runtime).
export const runtime = "nodejs";

// The user-facing report page: /report/<assessmentId>. Same facts as the
// PDF, presented as a conversation instead of a printed document — see
// renderReportChatHtml's own comment for why this diverges from the PDF
// template. This is a route handler (not a page.tsx) because the renderer
// returns a full standalone <html> document with its own styles — nesting
// that inside app/layout.tsx's own <html> wrapper would produce invalid,
// conflicting markup.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let assessmentId: bigint;
  try {
    assessmentId = BigInt(id);
  } catch {
    return new NextResponse("Invalid report link.", { status: 400 });
  }

  const assessment = await prisma.assessment.findUnique({
    where: { id: assessmentId },
    include: { facts: true },
  });

  if (!assessment) {
    return new NextResponse("This report doesn't exist.", { status: 404 });
  }
  if (assessment.facts.length === 0) {
    return new NextResponse("This report isn't ready yet.", { status: 404 });
  }

  const html = renderReportChatHtml(assessment);
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
