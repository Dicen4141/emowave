import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Staff notes attached to a client. Creation only — reading happens through
// /api/workspace/[assessmentId] alongside sources and generated artifacts, so
// the Studio panel fills itself from a single request rather than two.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const assessmentId = body?.assessmentId;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const noteBody = typeof body?.body === "string" ? body.body : "";

    if (!assessmentId) return NextResponse.json({ error: "assessmentId is required." }, { status: 400 });
    if (!title) return NextResponse.json({ error: "A note needs a title." }, { status: 400 });

    let id: bigint;
    try {
      id = BigInt(assessmentId);
    } catch {
      return NextResponse.json({ error: "assessmentId must be a number." }, { status: 400 });
    }

    // Checked explicitly so a bad id comes back as a clear 404 rather than a
    // raw foreign-key violation from the database.
    const exists = await prisma.assessment.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: `No assessment with id ${assessmentId}.` }, { status: 404 });

    const note = await prisma.note.create({
      data: { assessmentId: id, title, body: noteBody },
      select: { id: true, title: true, body: true, updatedAt: true },
    });

    return NextResponse.json({ ok: true, note: { ...note, id: note.id.toString() } }, { status: 201 });
  } catch (err) {
    console.error("Note create failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
