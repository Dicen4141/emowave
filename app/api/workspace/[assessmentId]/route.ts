import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadAssessmentForAi, listSources } from "@/lib/clientData";

export const runtime = "nodejs";

// Feeds the workspace page's Sources panel — which raw reports (Mind
// Report, Emotional Notes, iEmoWave Full) this client actually has on file,
// and how many fields came from each — plus the Studio panel's list of what
// has already been generated or written for this client.
export async function GET(_req: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = await params;
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

  // The Studio list is additive to this endpoint's original job, so it must
  // never be able to take the Sources panel down with it. It reads three
  // tables, one of which (notes) may not exist yet on a database that hasn't
  // had `prisma db push` run since the Note model was added — and on a client
  // generated before that model existed, `prisma.note` is undefined outright.
  // Either way that's a degraded Studio list, not a broken workspace.
  let generated: { kind: string; createdAt: Date }[] = [];
  let notes: { id: string; title: string; body: string; updatedAt: Date }[] = [];
  try {
    const [artifacts, mindMap, noteRows] = await Promise.all([
      prisma.studioArtifact.findMany({ where: { assessmentId: id }, select: { kind: true, createdAt: true } }),
      prisma.mindMapContent.findUnique({ where: { assessmentId: id }, select: { createdAt: true } }),
      prisma.note
        ? prisma.note.findMany({
            where: { assessmentId: id },
            select: { id: true, title: true, body: true, updatedAt: true },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve([]),
    ]);
    generated = [
      ...(mindMap ? [{ kind: "mind-map", createdAt: mindMap.createdAt }] : []),
      ...artifacts.map((a: { kind: string; createdAt: Date }) => ({ kind: a.kind, createdAt: a.createdAt })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    notes = noteRows.map((n: { id: bigint; title: string; body: string; updatedAt: Date }) => ({
      id: n.id.toString(),
      title: n.title,
      body: n.body,
      updatedAt: n.updatedAt,
    }));
  } catch (err) {
    // Logged rather than swallowed silently — a missing table here is a real
    // "you still need to run db push" signal, it just isn't fatal.
    console.error("Studio list unavailable for assessment", assessmentId, err);
  }

  return NextResponse.json({
    customerName: assessment.customerId,
    sources: listSources(assessment),
    generated,
    notes,
  });
}
