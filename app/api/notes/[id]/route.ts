import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

function parseId(raw: string): bigint | null {
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "Note id must be a number." }, { status: 400 });

    const body = await req.json().catch(() => null);
    const title = typeof body?.title === "string" ? body.title.trim() : undefined;
    const noteBody = typeof body?.body === "string" ? body.body : undefined;

    if (title === undefined && noteBody === undefined) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: "A note needs a title." }, { status: 400 });
    }

    const existing = await prisma.note.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: `No note with id ${id}.` }, { status: 404 });

    const note = await prisma.note.update({
      where: { id },
      data: { ...(title !== undefined ? { title } : {}), ...(noteBody !== undefined ? { body: noteBody } : {}) },
      select: { id: true, title: true, body: true, updatedAt: true },
    });

    return NextResponse.json({ ok: true, note: { ...note, id: note.id.toString() } });
  } catch (err) {
    console.error("Note update failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "Note id must be a number." }, { status: 400 });

    const existing = await prisma.note.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: `No note with id ${id}.` }, { status: 404 });

    await prisma.note.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Note delete failed:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
