import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAdminUser } from "@/lib/adminAuth";
import { referenceTable, type ReferenceTableConfig } from "@/lib/referenceTables";

export const runtime = "nodejs";

// These vendor lookup tables feed EVERY client's report (not just one
// assessment), so editing them is treated the same as adding a new client —
// superadmin only. A regular admin can still read the app's normal report
// data, just not touch the shared reference data behind it.
async function requireSuperadmin() {
  const user = await getAdminUser();
  if (user?.role !== "superadmin") {
    return NextResponse.json({ error: "Only a superadmin can edit reference data." }, { status: 403 });
  }
  return null;
}

// Each table's Prisma delegate has a different shape (composite key for
// character, autoincrement id for stress-range, etc.) so this stays an
// explicit switch rather than an `any`-typed generic lookup — the type
// safety is worth the repetition.
function delegateFor(key: string) {
  switch (key) {
    case "note-behavior":
      return prisma.noteBehaviorReference;
    case "character":
      return prisma.characterReference;
    case "emotion-code":
      return prisma.emotionCodeReference;
    case "attribute-code":
      return prisma.attributeCodeReference;
    case "stress-range":
      return prisma.stressRangeReference;
    case "fwm-stress-range":
      return prisma.fwmStressRange;
    case "fwm-present-character":
      return prisma.fwmPresentCharacter;
    case "fwm-real-intention":
      return prisma.fwmRealIntention;
    case "fwm-combination":
      return prisma.fwmCombination;
    case "fwm-comm-learn":
      return prisma.fwmCommLearn;
    case "fwm-decision-making":
      return prisma.fwmDecisionMaking;
    case "fwm-note-combination":
      return prisma.fwmNoteCombination;
    default:
      return null;
  }
}

const NOTE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Vendor codes like "c19"/"p9"/"a1" sort wrong as plain strings ("c19"
// lands before "c2" character-by-character). Splits each into its letter
// prefix and numeric suffix and compares those separately instead.
function naturalCodeCompare(a: string, b: string): number {
  const [, letterA = "", numA = ""] = /^([a-zA-Z]*)(\d*)$/.exec(a) ?? [];
  const [, letterB = "", numB = ""] = /^([a-zA-Z]*)(\d*)$/.exec(b) ?? [];
  if (letterA !== letterB) return letterA.localeCompare(letterB);
  return (Number(numA) || 0) - (Number(numB) || 0);
}

// Every table's own natural reading order — nothing here is enforced by the
// database, so rows otherwise come back in whatever order they happened to
// be inserted, which reads as random for a 134-row code table.
function sortRows(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  switch (table) {
    case "note-behavior":
      return [...rows].sort((a, b) => NOTE_ORDER.indexOf(a.note as string) - NOTE_ORDER.indexOf(b.note as string));
    case "character":
      return [...rows].sort((a, b) => (a.language as string).localeCompare(b.language as string) || (a.number as number) - (b.number as number));
    case "emotion-code":
    case "attribute-code":
      return [...rows].sort((a, b) => naturalCodeCompare(a.code as string, b.code as string));
    case "stress-range":
    case "fwm-stress-range":
      return [...rows].sort((a, b) => (a.stressFrom as number) - (b.stressFrom as number));
    case "fwm-present-character":
    case "fwm-real-intention":
      return [...rows].sort((a, b) => (a.type as number) - (b.type as number));
    case "fwm-combination":
      return [...rows].sort(
        (a, b) =>
          (a.presentCharacter as string).localeCompare(b.presentCharacter as string) ||
          (a.realIntention as string).localeCompare(b.realIntention as string),
      );
    case "fwm-comm-learn":
      return [...rows].sort((a, b) => (a.base as string).localeCompare(b.base as string));
    case "fwm-decision-making":
      return [...rows].sort((a, b) => (a.baseNext as string).localeCompare(b.baseNext as string));
    // Chromatic order on both halves of the pair, so the 144 rows read as a
    // 12x12 grid rather than alphabetically ("A#" before "C").
    case "fwm-note-combination":
      return [...rows].sort(
        (a, b) =>
          NOTE_ORDER.indexOf(a.note1 as string) - NOTE_ORDER.indexOf(b.note1 as string) ||
          NOTE_ORDER.indexOf(a.note2 as string) - NOTE_ORDER.indexOf(b.note2 as string),
      );
    default:
      return rows;
  }
}

function idWhere(config: ReferenceTableConfig, body: Record<string, unknown>) {
  const idFields = config.fields.filter((f) => f.isId);
  const where: Record<string, unknown> = {};
  for (const f of idFields) {
    if (body[f.key] === undefined || body[f.key] === null || body[f.key] === "") {
      throw new Error(`Missing id field "${f.label}".`);
    }
    where[f.key] = f.type === "int" ? Number(body[f.key]) : body[f.key];
  }
  return idFields.length > 1 ? { [idFields.map((f) => f.key).join("_")]: where } : where;
}

function coerceBody(config: ReferenceTableConfig, body: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const f of config.fields) {
    // Autoincrement ids (the two stress tables) are never accepted on create,
    // and never part of the editable payload on update — they're the identity.
    if (f.autoAssigned) continue;
    if (!(f.key in body)) continue;
    const raw = body[f.key];
    if (f.type === "int") data[f.key] = raw === "" || raw === null ? null : Number(raw);
    else if (f.type === "float") data[f.key] = raw === "" || raw === null ? null : Number(raw);
    else data[f.key] = raw === "" ? null : raw;
  }
  return data;
}

export async function GET(_req: Request, { params }: { params: Promise<{ table: string }> }) {
  const { table } = await params;
  const config = referenceTable(table);
  const delegate = delegateFor(table);
  if (!config || !delegate) return NextResponse.json({ error: `Unknown reference table "${table}".` }, { status: 404 });

  // @ts-expect-error -- each delegate's findMany has a different generated
  // type, but they all accept a plain call with no args.
  const rows = await delegate.findMany();
  return NextResponse.json({ config, rows: sortRows(table, rows) });
}

export async function POST(req: Request, { params }: { params: Promise<{ table: string }> }) {
  const unauthorized = await requireSuperadmin();
  if (unauthorized) return unauthorized;

  const { table } = await params;
  const config = referenceTable(table);
  const delegate = delegateFor(table);
  if (!config || !delegate) return NextResponse.json({ error: `Unknown reference table "${table}".` }, { status: 404 });

  const body = await req.json();
  for (const f of config.fields) {
    if (f.required && f.key !== "id" && !body[f.key]) {
      return NextResponse.json({ error: `"${f.label}" is required.` }, { status: 400 });
    }
  }
  const data = coerceBody(config, body);
  try {
    // @ts-expect-error -- same reason as GET, plus `data`'s shape is only
    // known at runtime via the config.
    const row = await delegate.create({ data });
    return NextResponse.json({ row });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message.includes("Unique constraint") ? "A row with that ID already exists." : message }, { status: 400 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ table: string }> }) {
  const unauthorized = await requireSuperadmin();
  if (unauthorized) return unauthorized;

  const { table } = await params;
  const config = referenceTable(table);
  const delegate = delegateFor(table);
  if (!config || !delegate) return NextResponse.json({ error: `Unknown reference table "${table}".` }, { status: 404 });

  const body = await req.json();
  try {
    const where = idWhere(config, body);
    const data = coerceBody(config, body);
    // @ts-expect-error -- same reason as GET/POST.
    const row = await delegate.update({ where, data });
    return NextResponse.json({ row });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ table: string }> }) {
  const unauthorized = await requireSuperadmin();
  if (unauthorized) return unauthorized;

  const { table } = await params;
  const config = referenceTable(table);
  const delegate = delegateFor(table);
  if (!config || !delegate) return NextResponse.json({ error: `Unknown reference table "${table}".` }, { status: 404 });

  const body = await req.json();
  try {
    const where = idWhere(config, body);
    // @ts-expect-error -- same reason as GET/POST.
    await delegate.delete({ where });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
