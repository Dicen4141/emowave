// Imports the Financial Wealth Management (FWM) reference data — the JSON that
// scripts/export-fwm-json.py produces from the vendor's four workbooks — into
// the fwm_* tables (see prisma/schema.prisma).
//
//   python scripts/export-fwm-json.py <drive-folder> scripts/fwm-data
//   node scripts/import-fwm-reference-data.mjs [data-dir]
//
// Re-running is safe. Each table is replaced wholesale rather than upserted
// row by row: these tables mirror a vendor workbook and hold nothing a user
// created, so "whatever the current workbook says" is always the correct end
// state, and a row the vendor DELETED between versions actually disappears
// instead of lingering forever. The flip side — and the reason this is worth
// stating — is that edits made in the admin reference-data editor are lost on
// the next import, exactly as with stress_range_reference today.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.argv[2] || path.join(__dirname, "fwm-data");

// Prisma reads DATABASE_URL from the environment; plain `node` doesn't load
// .env on its own, so seed it here the same way poll-quantemo-orders.mjs does.
// Existing values win, so a real environment variable still overrides the file.
for (const file of [".env", ".env.local"]) {
  try {
    for (const line of readFileSync(path.join(__dirname, "..", file), "utf8").split("\n")) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // A missing .env file is fine — the variable may already be set.
  }
}

const prisma = new PrismaClient();

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(DATA_DIR, `${name}.json`), "utf8"));
}

// createMany has a practical ceiling on how many rows fit in one statement;
// Decision_Making is 256 rows of long prose, so chunk rather than assume.
async function replaceAll(label, model, records, chunkSize = 100) {
  await model.deleteMany({});
  for (let i = 0; i < records.length; i += chunkSize) {
    await model.createMany({ data: records.slice(i, i + chunkSize) });
  }
  console.log(`  ${label}: ${records.length} rows`);
}

async function main() {
  console.log(`Importing FWM reference data from ${DATA_DIR}`);

  await replaceAll("fwm_stress_range", prisma.fwmStressRange, loadJson("fwm_stress_range"));
  await replaceAll("fwm_present_character", prisma.fwmPresentCharacter, loadJson("fwm_present_character"));
  await replaceAll("fwm_real_intention", prisma.fwmRealIntention, loadJson("fwm_real_intention"));
  await replaceAll("fwm_combination", prisma.fwmCombination, loadJson("fwm_combination"));
  await replaceAll("fwm_comm_learn", prisma.fwmCommLearn, loadJson("fwm_comm_learn"));
  await replaceAll("fwm_decision_making", prisma.fwmDecisionMaking, loadJson("fwm_decision_making"));
  await replaceAll("fwm_note_combination", prisma.fwmNoteCombination, loadJson("fwm_note_combination"));

  // The workbook ships 81 of the 100 possible Present x Real pairings — type 0
  // ("Seeker") is in both character sheets but in neither Combination column.
  // Report those by name at import time so the hole is visible here, rather
  // than only surfacing as a blank section for an unlucky client months later.
  const characters = (await prisma.fwmPresentCharacter.findMany({ select: { character: true } }))
    .map((c) => c.character);
  const pairs = new Set(
    (await prisma.fwmCombination.findMany({ select: { presentCharacter: true, realIntention: true } }))
      .map((c) => `${c.presentCharacter}|${c.realIntention}`),
  );
  const missing = characters.flatMap((p) =>
    characters.filter((r) => !pairs.has(`${p}|${r}`)).map((r) => `${p} + ${r}`),
  );
  if (missing.length) {
    console.warn(
      `\n  WARNING: ${missing.length} of ${characters.length ** 2} Present x Real pairings have no ` +
        `Combination row. Clients matching these render that section as a gap:`,
    );
    console.warn(`  ${missing.join(", ")}`);
  }
}

main()
  .catch((err) => {
    console.error("FWM import failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
