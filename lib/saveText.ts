import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Extracted } from "@/lib/gemini";

// Every extraction is dumped here as a .txt before it reaches the database,
// so there is always a plain-text record even if the DB write fails.
export const EXTRACTIONS_DIR = path.join(process.cwd(), "extractions");

// Strip anything that isn't safe in a Windows filename, so an odd PDF name
// can't escape EXTRACTIONS_DIR or produce an unwritable path.
function safeBaseName(fileName: string) {
  const base = path.basename(fileName).replace(/\.pdf$/i, "");
  const cleaned = base.replace(/[^a-zA-Z0-9-_ ]/g, "_").trim();
  return cleaned.slice(0, 60) || "document";
}

function render(data: Extracted, fileName: string, when: Date) {
  const lines = [
    `Name:       ${data.name}`,
    `Source PDF: ${fileName}`,
    `Extracted:  ${when.toISOString()}`,
    "",
    "=========================== FULL DOCUMENT TEXT ===========================",
    "",
    data.fullText.replace(/\r?\n/g, "\r\n"),
    "",
  ];

  // The table is only meaningful for documents that actually have one.
  if (data.table.length > 0) {
    lines.push(
      "=============================== TABLE ROWS ===============================",
      "",
      "Item                          | Quantity   | Price",
      "------------------------------+------------+------------",
    );
    for (const r of data.table) {
      lines.push(`${r.item.padEnd(29)} | ${r.quantity.padEnd(10)} | ${r.price}`);
    }
    lines.push("", `Rows: ${data.table.length}`, "");
  }

  lines.push("=============================== RAW JSON ================================", "", JSON.stringify(data, null, 2));
  return lines.join("\r\n") + "\r\n";
}

/** Writes the extraction to extractions/<time>-<name>.txt. Returns the full path. */
export async function saveExtractionText(data: Extracted, fileName: string) {
  const when = new Date();
  const stamp = when.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(EXTRACTIONS_DIR, `${stamp}-${safeBaseName(fileName)}.txt`);

  await mkdir(EXTRACTIONS_DIR, { recursive: true });
  await writeFile(filePath, render(data, fileName, when), "utf8");

  return filePath;
}
