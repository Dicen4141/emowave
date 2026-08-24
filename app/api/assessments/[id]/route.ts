import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Full detail for one assessment, including every report_facts row — this is
// what the admin "Manage Facts" panel reads to show table/row provenance.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let assessmentId: bigint;
    try {
      assessmentId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "id must be a number." }, { status: 400 });
    }

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        facts: { orderBy: { id: "asc" } },
        stressContent: true,
        emotionalStateContent: true,
        sensoryAttributesContent: true,
        presentCharacterContent: true,
        topAttributeContent: { orderBy: [{ kind: "asc" }, { rank: "asc" }] },
        wellnessChallengeContent: { orderBy: { rank: "asc" } },
        journeyOverviewContent: true,
      },
    });

    if (!assessment) {
      return NextResponse.json({ error: `No assessment with id ${id}.` }, { status: 404 });
    }

    const stringifyIds = <T extends { id: bigint }>(row: T) => ({ ...row, id: row.id.toString(), assessmentId: undefined });

    return NextResponse.json({
      id: assessment.id.toString(),
      customerId: assessment.customerId,
      customerEmail: assessment.customerEmail,
      status: assessment.status,
      facts: assessment.facts.map((f) => ({
        id: f.id.toString(),
        section: f.section,
        label: f.label,
        value: f.value,
      })),
      // Gemini-generated content — separate from the raw facts above, one
      // entry per report section (see prisma/schema.prisma). Singleton
      // tables come back as an object or null; TopAttribute/Wellness
      // Challenge are arrays of rows.
      stressContent: assessment.stressContent ? stringifyIds(assessment.stressContent) : null,
      emotionalStateContent: assessment.emotionalStateContent ? stringifyIds(assessment.emotionalStateContent) : null,
      sensoryAttributesContent: assessment.sensoryAttributesContent ? stringifyIds(assessment.sensoryAttributesContent) : null,
      presentCharacterContent: assessment.presentCharacterContent ? stringifyIds(assessment.presentCharacterContent) : null,
      topAttributeContent: assessment.topAttributeContent.map(stringifyIds),
      wellnessChallengeContent: assessment.wellnessChallengeContent.map(stringifyIds),
      journeyOverviewContent: assessment.journeyOverviewContent ? stringifyIds(assessment.journeyOverviewContent) : null,
    });
  } catch (err) {
    console.error("Assessment detail fetch failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Sets the client's email, matched against Quantemo's own users table by
// exact email (see lib/quantemo.ts) to look up their real age for the
// Journey Overview chart's age-bracket labels — customerId alone isn't a
// reliable match key (Quantemo has duplicate names).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let assessmentId: bigint;
    try {
      assessmentId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "id must be a number." }, { status: 400 });
    }

    const body = await req.json();
    if (typeof body.customerEmail !== "string") {
      return NextResponse.json({ error: "customerEmail must be a string." }, { status: 400 });
    }

    const assessment = await prisma.assessment.update({
      where: { id: assessmentId },
      data: { customerEmail: body.customerEmail.trim() || null },
    });

    return NextResponse.json({ id: assessment.id.toString(), customerEmail: assessment.customerEmail });
  } catch (err) {
    console.error("Assessment email update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
