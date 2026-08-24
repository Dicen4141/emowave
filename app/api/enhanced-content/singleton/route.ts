import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// One entry per singleton "*Content" table (see prisma/schema.prisma) — the
// allowlist of editable field names per table. Never construct a Prisma
// model/field access directly from request input; only these exact,
// explicitly-listed combinations are reachable.
const TABLES = {
  stress: { delegate: prisma.stressContent, fields: ["description"] },
  emotionalState: {
    delegate: prisma.emotionalStateContent,
    fields: [
      "note1ReactionDesc",
      "note2ReactionDesc",
      "publicSelfFull",
      "privateSelfFull",
      "frequentEmotionDesc",
      "coreEmotionDesc",
      "empoweringDesc",
      "disempoweringDesc",
    ],
  },
  sensoryAttributes: { delegate: prisma.sensoryAttributesContent, fields: ["baseDesc", "nextDesc"] },
  presentCharacter: { delegate: prisma.presentCharacterContent, fields: ["presentTrait", "presentSummary", "realTrait", "realSummary"] },
  journeyOverview: { delegate: prisma.journeyOverviewContent, fields: ["noteBalanceValues"] },
} as const;

type TableName = keyof typeof TABLES;

// Updates one section's Gemini-generated content for one assessment — the
// counterpart to PATCH /api/facts/[id] (which edits raw ReportFact rows).
// Body: { table: one of the keys above, assessmentId: string, data: {...} }.
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { table, assessmentId: assessmentIdRaw, data } = body ?? {};

    if (typeof table !== "string" || !(table in TABLES)) {
      return NextResponse.json({ error: `\`table\` must be one of: ${Object.keys(TABLES).join(", ")}.` }, { status: 400 });
    }
    let assessmentId: bigint;
    try {
      assessmentId = BigInt(assessmentIdRaw);
    } catch {
      return NextResponse.json({ error: "`assessmentId` must be a number." }, { status: 400 });
    }
    if (!data || typeof data !== "object") {
      return NextResponse.json({ error: "`data` must be an object." }, { status: 400 });
    }

    const { delegate, fields } = TABLES[table as TableName];
    const update: Record<string, unknown> = {};
    for (const key of fields) {
      if (key in data) update[key] = data[key];
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: `Provide at least one of: ${fields.join(", ")}.` }, { status: 400 });
    }

    // @ts-expect-error -- each delegate's upsert shape differs per table, but every one accepts assessmentId + these field-only updates
    const row = await delegate.upsert({
      where: { assessmentId },
      create: { assessmentId, ...update },
      update,
    });

    return NextResponse.json({ ok: true, row: { ...row, id: row.id.toString(), assessmentId: row.assessmentId.toString() } });
  } catch (err) {
    console.error("Enhanced content (singleton) update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
