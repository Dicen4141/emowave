import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Updates a single report_facts row by id — this IS the "which table, which
// row" the admin is editing: table `report_facts`, primary key `id`.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    let factId: bigint;
    try {
      factId = BigInt(id);
    } catch {
      return NextResponse.json({ error: "id must be a number." }, { status: 400 });
    }

    const body = await req.json();
    const data: { value?: string; label?: string; section?: string } = {};

    if (body.value !== undefined) {
      if (typeof body.value !== "string") {
        return NextResponse.json({ error: "`value` must be a string." }, { status: 400 });
      }
      data.value = body.value;
    }
    if (body.label !== undefined) {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json({ error: "`label` must be a non-empty string." }, { status: 400 });
      }
      data.label = body.label.trim();
    }
    if (body.section !== undefined) {
      if (typeof body.section !== "string" || !body.section.trim()) {
        return NextResponse.json({ error: "`section` must be a non-empty string." }, { status: 400 });
      }
      data.section = body.section.trim();
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Provide at least one of: value, label, section." }, { status: 400 });
    }

    const updated = await prisma.reportFact.update({
      where: { id: factId },
      data,
    });

    return NextResponse.json({
      ok: true,
      fact: { id: updated.id.toString(), label: updated.label, section: updated.section, value: updated.value },
    });
  } catch (err) {
    console.error("Fact update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
