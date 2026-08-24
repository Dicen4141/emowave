import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { writeFile, mkdir } from "node:fs/promises";
import type { Extracted } from "@/lib/gemini";
import { EXTRACTIONS_DIR } from "@/lib/saveText";

// A4 in points, with comfortable margins.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.8, 0.82, 0.85);
const HEADER_BG = rgb(0.94, 0.95, 0.97);

// Strip characters WinAnsi (StandardFonts) can't encode, so drawText never throws.
function clean(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•]/g, "-")
    .replace(/[·]/g, "-")
    .replace(/[^\x20-\x7E]/g, "");
}

// Break a string into lines that fit within maxWidth at the given font size.
function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/\s+/)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Builds a template PDF and drops the extracted values into their slots:
 * a title, a meta block, the extracted table, then the full text.
 * Writes to outPath (kept aligned with the sibling .txt name) and returns it.
 */
export async function makeFilledPdf(data: Extracted, fileName: string, outPath: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // Start a fresh page when we run out of vertical room.
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const text = (s: string, size: number, f: PDFFont, color = INK, x = MARGIN) => {
    page.drawText(clean(s), { x, y, size, font: f, color });
  };

  // --- Title slot ---------------------------------------------------------
  for (const line of wrap(data.name || "Untitled", bold, 20, CONTENT_W)) {
    ensure(26);
    text(line, 20, bold);
    y -= 26;
  }

  // --- Meta slot ----------------------------------------------------------
  y -= 4;
  ensure(16);
  text(`Source PDF: ${fileName}`, 10, font, MUTED);
  y -= 24;

  // --- Table slot ---------------------------------------------------------
  if (data.table.length > 0) {
    ensure(24);
    text("Extracted Table", 13, bold);
    y -= 20;

    const cols = [
      { label: "Item", key: "item" as const, w: CONTENT_W * 0.5 },
      { label: "Quantity", key: "quantity" as const, w: CONTENT_W * 0.2 },
      { label: "Price", key: "price" as const, w: CONTENT_W * 0.3 },
    ];

    const drawRow = (
      values: string[],
      f: PDFFont,
      bg?: ReturnType<typeof rgb>,
    ) => {
      // Pre-wrap every cell to find the tallest, so rows size to content.
      const wrapped = values.map((v, i) =>
        wrap(v, f, 10, cols[i].w - 12),
      );
      const rowH = Math.max(...wrapped.map((w) => w.length)) * 13 + 8;
      ensure(rowH);

      if (bg) {
        page.drawRectangle({ x: MARGIN, y: y - rowH + 4, width: CONTENT_W, height: rowH, color: bg });
      }

      let cx = MARGIN;
      wrapped.forEach((lines, i) => {
        lines.forEach((ln, li) => {
          page.drawText(clean(ln), {
            x: cx + 6,
            y: y - 10 - li * 13,
            size: 10,
            font: f,
            color: INK,
          });
        });
        cx += cols[i].w;
      });

      // Bottom border for the row.
      page.drawLine({
        start: { x: MARGIN, y: y - rowH + 4 },
        end: { x: MARGIN + CONTENT_W, y: y - rowH + 4 },
        thickness: 0.5,
        color: LINE,
      });
      y -= rowH;
    };

    drawRow(cols.map((c) => c.label), bold, HEADER_BG);
    for (const r of data.table) {
      drawRow([r.item, r.quantity, r.price], font);
    }
    y -= 16;
  }

  // --- Full text slot -----------------------------------------------------
  if (data.fullText.trim()) {
    ensure(24);
    text("Full Text", 13, bold);
    y -= 18;
    for (const line of wrap(data.fullText, font, 10, CONTENT_W)) {
      ensure(13);
      text(line, 10, font);
      y -= 13;
    }
  }

  const bytes = await doc.save();

  await mkdir(EXTRACTIONS_DIR, { recursive: true });
  await writeFile(outPath, bytes);
  return outPath;
}
