import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkReportGaps } from "@/lib/reportGapCheck";

export const runtime = "nodejs";

// Fast, non-rendering companion to /api/generate-report — lists data gaps
// (e.g. "no Journey Overview data") without generating the actual PDF, so
// the EmoSpace preview can show a warning banner before the user opens a
// report that's missing something, instead of them having to notice it by
// reading through the whole thing.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const idParam = searchParams.get("assessmentId");
    if (!idParam) {
      return NextResponse.json({ error: "Missing ?assessmentId=" }, { status: 400 });
    }
    let assessmentId: bigint;
    try {
      assessmentId = BigInt(idParam);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        facts: true,
        stressContent: true,
        emotionalStateContent: true,
        sensoryAttributesContent: true,
        presentCharacterContent: true,
        topAttributeContent: true,
        wellnessChallengeContent: true,
        journeyOverviewContent: true,
      },
    });
    if (!assessment) {
      return NextResponse.json({ error: `No assessment with id ${idParam}.` }, { status: 404 });
    }

    return NextResponse.json({ warnings: checkReportGaps(assessment) });
  } catch (err) {
    console.error("Report gap check failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
