import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Multi-row "*Content" tables — one row per Top-5 Attribute / Wellness
// Challenge entry, edited by row id (like PATCH /api/facts/[id] for
// ReportFact). Only these two tables are reachable, never an arbitrary
// Prisma model built from request input.
const TABLES = {
  topAttribute: prisma.topAttributeContent,
  wellnessChallenge: prisma.wellnessChallengeContent,
} as const;

type TableName = keyof typeof TABLES;

// Body: { table: "topAttribute" | "wellnessChallenge", id: string, label?: string, description?: string }.
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { table, id: idRaw, label, description } = body ?? {};

    if (typeof table !== "string" || !(table in TABLES)) {
      return NextResponse.json({ error: `\`table\` must be one of: ${Object.keys(TABLES).join(", ")}.` }, { status: 400 });
    }
    let id: bigint;
    try {
      id = BigInt(idRaw);
    } catch {
      return NextResponse.json({ error: "`id` must be a number." }, { status: 400 });
    }

    const update: { label?: string; description?: string } = {};
    if (label !== undefined) {
      if (typeof label !== "string" || !label.trim()) {
        return NextResponse.json({ error: "`label` must be a non-empty string." }, { status: 400 });
      }
      update.label = label.trim();
    }
    if (description !== undefined) {
      if (typeof description !== "string" || !description.trim()) {
        return NextResponse.json({ error: "`description` must be a non-empty string." }, { status: 400 });
      }
      update.description = description.trim();
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Provide at least one of: label, description." }, { status: 400 });
    }

    const delegate = TABLES[table as TableName];
    // @ts-expect-error -- both delegates share the same {label, description} update shape
    const row = await delegate.update({ where: { id }, data: update });

    return NextResponse.json({ ok: true, row: { ...row, id: row.id.toString(), assessmentId: row.assessmentId.toString() } });
  } catch (err) {
    console.error("Enhanced content (row) update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
