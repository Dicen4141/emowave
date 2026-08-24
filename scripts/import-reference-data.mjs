// One-time (re-runnable) import of the vendor's reference-data spreadsheets
// into the *_reference tables (see prisma/schema.prisma). The spreadsheets
// themselves were converted to JSON via a Python/openpyxl script (Excel
// reading isn't otherwise a project dependency) — this script just loads
// that JSON and upserts it. Re-running is safe: every table is keyed so a
// second run just overwrites with the same (or updated) data, never
// duplicates rows.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.argv[2] || __dirname;

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(DATA_DIR, name), "utf8"));
}

const prisma = new PrismaClient();

async function main() {
  const notes = loadJson("note_behavior.json");
  for (const n of notes) {
    await prisma.noteBehaviorReference.upsert({
      where: { note: n.note },
      create: n,
      update: n,
    });
  }
  console.log(`noteBehaviorReference: ${notes.length} rows`);

  const characters = loadJson("character.json");
  for (const c of characters) {
    await prisma.characterReference.upsert({
      where: { language_number: { language: c.language, number: c.number } },
      create: c,
      update: c,
    });
  }
  console.log(`characterReference: ${characters.length} rows`);

  const emotionCodes = loadJson("emotion_code.json");
  for (const e of emotionCodes) {
    await prisma.emotionCodeReference.upsert({
      where: { code: e.code },
      create: e,
      update: e,
    });
  }
  console.log(`emotionCodeReference: ${emotionCodes.length} rows`);

  const attributeCodes = loadJson("attribute_code.json");
  for (const a of attributeCodes) {
    await prisma.attributeCodeReference.upsert({
      where: { code: a.code },
      create: a,
      update: a,
    });
  }
  console.log(`attributeCodeReference: ${attributeCodes.length} rows`);

  // Stress ranges have no natural unique key across re-imports (no vendor
  // code, just numeric bounds) — wipe and re-insert wholesale each run
  // rather than trying to upsert-match rows that could shift.
  const stressRanges = loadJson("stress_range.json");
  await prisma.stressRangeReference.deleteMany({});
  await prisma.stressRangeReference.createMany({ data: stressRanges });
  console.log(`stressRangeReference: ${stressRanges.length} rows`);
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
