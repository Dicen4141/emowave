import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadAssessmentForAi, buildClientDataSummary } from "@/lib/clientData";
import { generateMindMap } from "@/lib/mindMap";

export const runtime = "nodejs";

// Cached after the first generation (see MindMapContent in schema.prisma) —
// opening the same client's mind map repeatedly is a plain DB read, not a
// fresh Gemini call every time. Pass ?refresh=true to force regeneration
// (e.g. after new sources were added for this client).
export async function GET(req: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const { assessmentId } = await params;
    const query = new URL(req.url).searchParams;
    const topic = query.get("topic")?.trim() || undefined;
    // A topic asks for a different map than the cached one, so it always
    // regenerates rather than serving whatever was generated first.
    const forceRefresh = query.get("refresh") === "true" || Boolean(topic);
    let id: bigint;
    try {
      id = BigInt(assessmentId);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    const assessment = await loadAssessmentForAi(id);
    if (!assessment) {
      return NextResponse.json({ error: `No assessment with id ${assessmentId}.` }, { status: 404 });
    }

    if (!forceRefresh) {
      const cached = await prisma.mindMapContent.findUnique({ where: { assessmentId: id } });
      if (cached) {
        return NextResponse.json({ ok: true, customerName: assessment.customerId, mindMap: cached.data, cached: true });
      }
    }

    const sourceText = buildClientDataSummary(assessment);
    if (!sourceText) {
      return NextResponse.json({ error: "This assessment doesn't have enough processed content yet to build a mind map." }, { status: 422 });
    }

    const mindMap = await generateMindMap(assessment.customerId, sourceText, topic);
    if (!mindMap) {
      return NextResponse.json({ error: "Mind map generation failed — check server logs (likely a Gemini API issue)." }, { status: 502 });
    }

    await prisma.mindMapContent.upsert({
      where: { assessmentId: id },
      create: { assessmentId: id, data: mindMap },
      update: { data: mindMap },
    });

    return NextResponse.json({ ok: true, customerName: assessment.customerId, mindMap, cached: false });
  } catch (err) {
    console.error("Mind map endpoint failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
