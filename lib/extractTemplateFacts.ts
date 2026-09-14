import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { deflateSync } from "node:zlib";
import { paraphraseFacts, readNoteBalanceChart, generateTraitPhrase } from "./paraphrase";

export type Fact = { label: string; text: string | null };

async function loadDoc(pdfBytes: Buffer | Uint8Array) {
  const data = new Uint8Array(pdfBytes);
  return pdfjsLib.getDocument({ data }).promise;
}

// ---------------------------------------------------------------------------
// The "Note Balance" chart (Emotional Notes page 3) has its per-note numbers
// baked into image pixels, not selectable PDF text — no OCR library in this
// project, so the image itself goes to Gemini Vision to read out. Same
// pdf.js-decode + zlib-only PNG encode approach used earlier this session
// for the Rhythmic Pattern chart (no `canvas` dependency needed).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Encodes raw RGB pixel data (3 bytes/px) or RGBA (4 bytes/px) into a PNG.
function encodePng(width: number, height: number, data: Uint8ClampedArray | Uint8Array, channels: 3 | 4): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = channels === 4 ? 6 : 2; // color type: 6=RGBA, 2=RGB
  const ihdr = pngChunk("IHDR", ihdrData);

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = pngChunk("IDAT", deflateSync(raw));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Picks the image most likely to be the "Note Balance" mountain chart among
// a page's other images (a decorative full-width background photo, a small
// square L/R-balance chart) — this template consistently puts that
// decorative photo at the TOP of the page and the real chart further down,
// below the explanatory paragraph (confirmed against the client's own
// reference page), so position is a more reliable signal than aspect ratio
// alone: a photo can accidentally have chart-like proportions (confirmed —
// one client's Note Balance read kept failing because the header photo's
// aspect ratio beat the real chart's), but it can't accidentally be in the
// bottom half of the page.
//
// Walks the operator list tracking the CTM through save/transform/restore
// (pdf.js only gives an image's pixel dimensions via paintImageXObject, not
// its on-page position — that requires replaying the same transform stack a
// renderer would) so each image's actual vertical position is known, not
// just its dimensions.
async function extractWidestAspectImage(doc: any, pageNum: number): Promise<string | null> {
  const page = await doc.getPage(pageNum);
  const opList = await page.getOperatorList();
  const { OPS } = pdfjsLib;
  const pageHeight = page.getViewport({ scale: 1 }).height;

  type M = [number, number, number, number, number, number];
  const multiply = (m1: M, m2: M): M => [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];

  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const candidates: { width: number; height: number; data: Uint8ClampedArray | Uint8Array; channels: 3 | 4; ratio: number; yCenter: number }[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
      continue;
    }
    if (fn === OPS.transform) {
      ctm = multiply(args as M, ctm);
      continue;
    }
    if (fn !== OPS.paintImageXObject) continue;
    const name = args[0];
    const img = await new Promise<any>((resolve, reject) => {
      try {
        page.objs.get(name, resolve);
      } catch (e) {
        reject(e);
      }
    });
    // kind 2 = RGB_24BPP, kind 3 = RGBA_32BPP (pdf.js ImageKind).
    if (!img || (img.kind !== 2 && img.kind !== 3)) continue;
    // An image is painted into the unit square [0,1]x[0,1]; mapping its
    // corners through the current CTM gives its actual position in PDF page
    // space (origin bottom-left, y increases upward).
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
    const ys = corners.map((c) => c[1]);
    const yCenter = (Math.min(...ys) + Math.max(...ys)) / 2;
    candidates.push({ width: img.width, height: img.height, data: img.data, channels: img.kind === 3 ? 4 : 3, ratio: img.width / img.height, yCenter });
  }
  if (candidates.length === 0) return null;

  // Prefer images in the bottom half of the page (y measured from the
  // bottom, so "bottom half" is yCenter < pageHeight/2); only fall back to
  // considering every image on the page if none qualify there, so a
  // differently-laid-out export still finds something rather than nothing.
  const lower = candidates.filter((c) => c.yCenter < pageHeight / 2);
  const pool = lower.length > 0 ? lower : candidates;
  const best = pool.reduce((a, b) => (b.ratio > a.ratio ? b : a));

  const png = encodePng(best.width, best.height, best.data, best.channels);
  return `data:image/png;base64,${png.toString("base64")}`;
}

// Joined with plain spaces (not newlines) and whitespace-collapsed, so the
// same regex anchors work regardless of how a given PDF library wraps lines.
async function normalizedPageText(doc: any, pageNum: number): Promise<string> {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const raw = tc.items.map((it: any) => it.str).join(" ");
  return raw.replace(/\s+/g, " ").trim();
}

// PDF.js (and the source PDF's own content stream) does NOT guarantee items
// come out in visual reading order — this vendor's two-column pages (e.g.
// page 8's side-by-side "Base:" / "Next:" boxes) interleave the two columns
// unpredictably. For those pages we bucket items by x-position and re-sort
// each bucket top-to-bottom (y descending — PDF y-axis points up) before
// joining, so the reconstructed text actually reads in the right order.
async function columnText(doc: any, pageNum: number, xMin: number, xMax: number): Promise<string> {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const items = tc.items
    .filter((it: any) => it.str && it.str.trim())
    .filter((it: any) => it.transform[4] >= xMin && it.transform[4] < xMax)
    .sort((a: any, b: any) => b.transform[5] - a.transform[5]);
  return items
    .map((it: any) => it.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sliceBetween(text: string, startPat: RegExp, endPats: RegExp[], occurrence = 1): string | null {
  const re = new RegExp(startPat.source, startPat.flags.includes("g") ? startPat.flags : startPat.flags + "g");
  let m: RegExpExecArray | null = null;
  let count = 0;
  while ((m = re.exec(text))) {
    count++;
    if (count === occurrence) break;
  }
  if (!m || count < occurrence) return null;

  const start = m.index + m[0].length;
  let end = text.length;
  for (const ep of endPats) {
    const em = ep.exec(text.slice(start));
    if (em) end = Math.min(end, start + em.index);
  }
  return text.slice(start, end).trim() || null;
}

const STRESS_TYPES = ["Low stress", "Logical stress", "Cumulative stress", "Emotional stress", "High stress", "Very High stress"];

const NOTE_SCALE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Position-based extraction, used for the "iEmoWave Full" template — its
// pages have real per-client data (not baked into images), but the PDF's own
// content stream doesn't emit it in visual reading order (same root problem
// as Aquera's two-column page). Sorting every text span by (y, x) instead of
// trusting stream order reconstructs the true reading order reliably.
// ---------------------------------------------------------------------------

type Span = { y: number; x: number; text: string };

async function pageSpans(doc: any, pageNum: number): Promise<Span[]> {
  const page = await doc.getPage(pageNum);
  const tc = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const spans: Span[] = [];
  for (const it of tc.items as any[]) {
    const t = (it.str ?? "").trim();
    if (!t) continue;
    // pdf.js y is bottom-up (PDF space) AND is the text's baseline, not the
    // top of its bounding box — PyMuPDF (used to originally measure every
    // coordinate constant in extractEwFullFacts) reports bbox-top instead.
    // Flipping without correcting for that left every band shifted by
    // roughly one font-height, which is why header rows and column splits
    // were leaking into the wrong fields. Subtracting item.height corrects
    // for it — verified against known reference points (e.g. "Note 1" at
    // PyMuPDF y=216.6 vs this formula's 216.5).
    const yTopDown = viewport.height - it.transform[5] - (it.height ?? 0);
    spans.push({ y: Math.round(yTopDown), x: it.transform[4], text: t });
  }
  spans.sort((a, b) => a.y - b.y || a.x - b.x);
  return spans;
}

function joinSpans(spans: Span[]): string {
  return spans.map((s) => s.text).join(" ");
}

function inBand(spans: Span[], yMin: number, yMax: number, xMin = -Infinity, xMax = Infinity): Span[] {
  return spans.filter((s) => s.y >= yMin && s.y < yMax && s.x >= xMin && s.x < xMax);
}

// Rebuild a page as visual lines: spans grouped by baseline (pageSpans has
// already flipped y to top-down), each line's spans re-joined left-to-right.
// This is the position-based counterpart to normalizedPageText, which joins
// pdf.js items in raw content-stream order — an order this vendor's boxed
// layouts do NOT follow (same hazard columnText documents). Anything that
// needs to know what sits above what on the page has to come through here.
// The 4pt tolerance absorbs the sub-point baseline jitter pdf.js reports for
// spans that are visually on one line; it is well under this template's
// ~12pt line spacing, so adjacent lines can't merge.
function pageLines(spans: Span[], yTolerance = 4): { y: number; text: string }[] {
  const groups: { y: number; spans: Span[] }[] = [];
  for (const s of [...spans].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(s.y - last.y) <= yTolerance) last.spans.push(s);
    else groups.push({ y: s.y, spans: [s] });
  }
  return groups.map((g) => ({
    y: g.y,
    text: g.spans
      .sort((a, b) => a.x - b.x)
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

// A document's pages, read once and addressed by WHAT IS PRINTED on them
// rather than by index.
//
// Every template here has sections that move. An optional section that's
// absent for one client shifts every page after it; a paragraph that wraps to
// one extra line pushes the box below it onto the next page. Addressing a page
// by number goes wrong the moment that happens — and goes wrong SILENTLY,
// because the wrong page usually still matches the anchor the slice is looking
// for. The Mind Report prints "The Inner Self" on two consecutive pages, so a
// one-page shift swapped a client's base type for their growth type with no
// warning at all: the field looked extracted, it just described someone else.
//
// So every read here is "find the page, then read it", never "read page N".
// `match` is the section's own fingerprint; `distinguishBy` separates pages
// that share one (the two Inner Self pages are told apart by "(base)" vs
// "(growing towards)"). Prefer a fingerprint that is structural — a heading
// the vendor prints, ideally the very text the caller is about to slice — over
// vendor prose, which gets reworded between exports: this template's "Benefits
// of mastery: When you master your inner quest for character..." anchor had
// already silently become "...When you deepen your inner journey".
//
// Returns null rather than guessing, so a genuinely absent section surfaces as
// that field's "!! NOT FOUND !!" in the extraction log and in the upload UI's
// "Could not extract" line — a visible miss instead of invisible wrong data.
type PageFinder = {
  count: number;
  text(pageNo: number): string;
  find(opts: { match: RegExp; distinguishBy?: RegExp }): number | null;
};

async function indexPages(doc: any): Promise<PageFinder> {
  const texts: string[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) texts[pageNo] = await normalizedPageText(doc, pageNo);
  // A /g regex carries lastIndex between .test() calls, so the same pattern
  // reused across pages would skip matches. Strip it — callers shouldn't have
  // to know that, and a stray /g here would look like a missing section.
  const stateless = (r: RegExp) => (r.flags.includes("g") ? new RegExp(r.source, r.flags.replace(/g/g, "")) : r);
  return {
    count: doc.numPages,
    text: (pageNo) => texts[pageNo] ?? "",
    find({ match, distinguishBy }) {
      const m = stateless(match);
      const candidates: number[] = [];
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) if (m.test(texts[pageNo])) candidates.push(pageNo);
      if (!candidates.length) return null;
      if (!distinguishBy) return candidates[0];
      const d = stateless(distinguishBy);
      const narrowed = candidates.filter((pageNo) => d.test(texts[pageNo]));
      // Several pages carry the fingerprint and none carries the
      // disambiguator: that's ambiguous, not "probably the first one".
      return narrowed.length ? narrowed[0] : null;
    },
  };
}

type NumberedRow = { no: string; label: string; description: string };

// Parses a "No. | Label | Description" table using the row-number markers
// (1, 2, 3...) as row boundaries — row windows are the MIDPOINT between
// consecutive markers, not "starts exactly at the marker's y", because a
// row's number isn't always aligned to its label's first line (sometimes
// it's vertically centered against a multi-line label).
function numberedRows(
  spans: Span[],
  opts: {
    noXMax: number;
    labelXMin: number;
    labelXMax: number;
    descXMin: number;
    descXMax?: number;
    yStart: number;
    yEnd: number;
  },
): NumberedRow[] {
  const region = inBand(spans, opts.yStart, opts.yEnd);
  const markers = region.filter((s) => s.x < opts.noXMax && /^\d+$/.test(s.text)).sort((a, b) => a.y - b.y);

  return markers.map((m, i) => {
    const rowStart = i === 0 ? opts.yStart : (markers[i - 1].y + m.y) / 2;
    const rowEnd = i + 1 >= markers.length ? opts.yEnd : (m.y + markers[i + 1].y) / 2;
    const row = region.filter((s) => s.y >= rowStart && s.y < rowEnd);
    const label = row.filter((s) => s.x >= opts.labelXMin && s.x < opts.labelXMax);
    const desc = row.filter((s) => s.x >= opts.descXMin && (opts.descXMax === undefined || s.x < opts.descXMax));
    return { no: m.text, label: joinSpans(label), description: joinSpans(desc) };
  });
}

// "iEmoWave Full" template — a third report format (alongside Aquera and
// Emotional Notes), confirmed by the client to be sent for every customer.
// The Rhythmic Pattern note-chart is baked into an image with no underlying
// text data on the page — the report must not reproduce the vendor's own
// graphic, so it's not extracted here at all; the renderer redraws its own
// note-scale chart from the Note 1/Note 2 values already captured above.
export async function extractEwFullFacts(pdfBytes: Buffer | Uint8Array): Promise<Fact[]> {
  const doc = await loadDoc(pdfBytes);
  const fields: Fact[] = [];

  // ---------------- PAGE 1 ----------------
  const sp1 = await pageSpans(doc, 1);

  const scoreMatch = joinSpans(inBand(sp1, 80, 100)).match(/(\d+\s*\.\s*\d+)/);
  fields.push({ label: "Stress Level - score", text: scoreMatch ? scoreMatch[1].replace(/\s+/g, "") : null });
  fields.push({ label: "Stress Level - description", text: joinSpans(inBand(sp1, 108, 135)) || null });

  // "Empowering" (JOY/COOLNESS) vs "Dis-empowering" (MISERY/SURPRISE) —
  // the header words themselves are fixed, only which emotion pair fills
  // each side varies per client.
  fields.push({ label: "Empowering Emotion", text: joinSpans(inBand(sp1, 190, 210, -Infinity, 200)) || null });
  fields.push({ label: "Dis-empowering Emotion", text: joinSpans(inBand(sp1, 190, 210, 200)) || null });

  // Note 1's reaction paragraph wraps to a different number of lines per
  // client, which pushes "Note 2" — and everything below it, all the way
  // down to Frequent/Core Emotion — down by a variable amount (confirmed:
  // "Note 2" header sits at y≈249 for one client and y≈260 for another).
  // Fixed y-bands can't survive that, so anchor on the actual header spans
  // instead of hardcoded coordinates. Match by prefix, not exact equality —
  // pdf.js sometimes emits "Note 1" as a single combined span and sometimes
  // as separate "Note" + "1" spans depending on the source PDF, so a prefix
  // match on "Note" catches either shape as long as we take them in y order.
  const noteHeaders = sp1.filter((s) => /^Note\b/.test(s.text) && s.x < 100).sort((a, b) => a.y - b.y);
  const rhythmicHeader = sp1.find((s) => /^Rhythmic\b/.test(s.text) && s.x < 100);
  const note1Y = noteHeaders[0]?.y ?? 216;
  const note2Y = noteHeaders[1]?.y ?? note1Y + 33;
  const rhythmicY = rhythmicHeader?.y ?? note2Y + 40;

  fields.push({ label: "Emotional State - Note 1", text: joinSpans(inBand(sp1, note1Y + 4, note2Y - 3, -Infinity, 100)) || null });
  fields.push({
    label: "Emotional State - Note 1 reaction",
    text: joinSpans(inBand(sp1, note1Y + 8, note2Y - 3, 150)) || null,
  });
  fields.push({ label: "Emotional State - Note 2", text: joinSpans(inBand(sp1, note2Y + 4, rhythmicY - 3, -Infinity, 100)) || null });
  fields.push({
    label: "Emotional State - Note 2 reaction",
    text: joinSpans(inBand(sp1, note2Y + 8, rhythmicY - 3, 150)) || null,
  });

  // Frequent/Core Emotion drift the same way. Rather than guess a y-band
  // for the code line vs. the (1- or 2-line) description below it, read
  // the whole column as one blob from the header down and split it on
  // sentence structure: "<code> <label sentence>. <description...>" — the
  // code+label is always the first sentence, the rest (which may be empty)
  // is the description.
  const freqHeader = sp1.find((s) => /^Frequent\b/.test(s.text) && s.x < 100);
  const freqHeaderY = freqHeader?.y ?? 452;
  const freqBlob = joinSpans(inBand(sp1, freqHeaderY + 4, freqHeaderY + 70, -Infinity, 200));
  const coreBlob = joinSpans(inBand(sp1, freqHeaderY + 4, freqHeaderY + 70, 200));

  const codeLabelDesc = (blob: string): { code: string; label: string; desc: string } | null => {
    const m = /^(\S+)\s+([^.]+\.)\s*(.*)$/.exec(blob.trim());
    return m ? { code: m[1], label: m[2].trim(), desc: m[3].trim() } : null;
  };

  const freqParsed = codeLabelDesc(freqBlob);
  fields.push({ label: "Frequent Emotion", text: freqParsed ? `${freqParsed.code}: ${freqParsed.label}` : null });
  fields.push({ label: "Frequent Emotion - description", text: freqParsed?.desc || null });

  const coreParsed = codeLabelDesc(coreBlob);
  fields.push({ label: "Core Emotion", text: coreParsed ? `${coreParsed.code}: ${coreParsed.label}` : null });
  fields.push({ label: "Core Emotion - description", text: coreParsed?.desc || null });

  // ---------------- PAGE 2 ----------------
  const sp2 = await pageSpans(doc, 2);

  fields.push({
    label: "Sensory Attributes - BASE",
    text: joinSpans(inBand(sp2, 80, 100, -Infinity, 216)) || null,
  });
  fields.push({ label: "Sensory Attributes - NEXT", text: joinSpans(inBand(sp2, 80, 100, 216)) || null });

  const left = joinSpans(inBand(sp2, 160, 170, -Infinity, 216));
  const right = joinSpans(inBand(sp2, 160, 170, 216));
  fields.push({ label: "Brain Activities", text: left ? `Left=${left}, Right=${right}` : null });

  // Present Character / Real Intention are 3-column tables (Character |
  // Present Character | Summary) whose rows overlap in y — bucket by x
  // within the row band, same fix as Aquera's 2-column page.
  const pcRegion = inBand(sp2, 225, 276);
  const pcChar = joinSpans(pcRegion.filter((s) => s.x < 70));
  const pcTrait = joinSpans(pcRegion.filter((s) => s.x >= 70 && s.x < 170));
  const pcSummary = joinSpans(pcRegion.filter((s) => s.x >= 170));
  fields.push({ label: "Present Character", text: pcChar || null });
  fields.push({ label: "Present Character - trait", text: pcTrait || null });
  fields.push({ label: "Present Character - summary", text: pcSummary || null });

  // yStart is 308, not 294 — the "Character | Real Intention | Summary"
  // column-header row sits at y≈300.6, just above the actual data row at
  // y≈316; starting the band too early was sweeping those header words
  // into the data itself.
  const riRegion = inBand(sp2, 308, 341);
  const riChar = joinSpans(riRegion.filter((s) => s.x < 70));
  const riTrait = joinSpans(riRegion.filter((s) => s.x >= 70 && s.x < 170));
  const riSummary = joinSpans(riRegion.filter((s) => s.x >= 170));
  fields.push({ label: "Real Intention", text: riChar || null });
  fields.push({ label: "Real Intention - trait", text: riTrait || null });
  fields.push({ label: "Real Intention - summary", text: riSummary || null });

  const dynTitles = inBand(sp2, 350, 435).filter((s) => /^\d - /.test(s.text));
  for (const title of dynTitles) {
    const isLeft = title.x < 216;
    const rating = joinSpans(
      inBand(sp2, title.y + 8, title.y + 20).filter((s) => (s.x < 216) === isLeft),
    );
    fields.push({ label: `Leadership Dynamic: ${title.text}`, text: rating || null });
  }

  // ---------------- PAGE 3 ----------------
  const sp3 = await pageSpans(doc, 3);

  const constructive = numberedRows(sp3, {
    noXMax: 45,
    labelXMin: 45,
    labelXMax: 200,
    descXMin: 200,
    yStart: 100,
    yEnd: 180,
  });
  for (const r of constructive) {
    fields.push({ label: `Constructive Attribute ${r.no}`, text: r.label || null });
    fields.push({ label: `Constructive Attribute ${r.no} - description`, text: r.description || null });
  }

  // Label column words top out ~x=94 ("Compulsively", "Reading") and the
  // description column starts consistently at x=100.01 across every row
  // (verified via PyMuPDF word dump on a real client PDF) — the old 125
  // threshold sat inside the description column itself, so desc words with
  // x in [100,125) (e.g. "This", "can", "be") got misclassified into the
  // label bucket and interleaved with the label's own wrapped lines.
  //
  // The table actually holds 5 rows, not 3 — the old yEnd:353 cut off row
  // 4's marker ("4" at y=359.58) while still sweeping in row 4's first line
  // (y=352.08, "i22 - In the"), which had no row boundary left to land in
  // and got glued onto row 3's tail. yEnd:405 covers rows 4-5 (content ends
  // ~394.78) while stopping well short of the next section's header at
  // y=408.12 ("POTENTIAL MENTAL & PHYSICAL WELLNESS CHALLENGE").
  const restrictive = numberedRows(sp3, {
    noXMax: 40,
    labelXMin: 40,
    labelXMax: 97,
    descXMin: 97,
    descXMax: 290,
    yStart: 220,
    yEnd: 405,
  });
  for (const r of restrictive) {
    fields.push({ label: `Restrictive Attribute ${r.no}`, text: r.label || null });
    fields.push({ label: `Restrictive Attribute ${r.no} - description`, text: r.description || null });
  }

  const codeValueRegion = inBand(sp3, 213, 340, 290);
  const codes = codeValueRegion.filter((s) => s.x < 350).sort((a, b) => a.y - b.y);
  const values = codeValueRegion.filter((s) => s.x >= 350).sort((a, b) => a.y - b.y);
  const pairs = codes.map((c, i) => `${c.text}=${values[i]?.text ?? "?"}`).join(", ");
  fields.push({ label: "Past Experiences - Code/Value", text: pairs || null });

  const wellness = numberedRows(sp3, {
    noXMax: 35,
    labelXMin: 35,
    labelXMax: 110,
    descXMin: 110,
    descXMax: 300,
    yStart: 440,
    yEnd: 600,
  });
  for (const r of wellness) {
    fields.push({ label: `Wellness Challenge ${r.no}`, text: r.label || null });
    fields.push({ label: `Wellness Challenge ${r.no} - description`, text: r.description || null });
  }

  fields.push({
    label: "Wellness - Organ Indicators",
    text: joinSpans(inBand(sp3, 379, 432, 340)) || null,
  });

  // ---------------- PAGE 5 ----------------
  // The Journey Overview chart's grid/tick-marks are baked into an image
  // (still not extracted — see the module comment), but the 12 age-bracket
  // numbers below it are real text, and its tick LEVELS turn out to be
  // exactly the "Past Experiences - Code/Value" numbers from page 3 (client-
  // confirmed: value 3 for note C ⇒ column 1 sits at level 3) — so the chart
  // itself is fully reconstructable from data we already extract.
  if (doc.numPages >= 5) {
    const sp5 = await pageSpans(doc, 5);
    // y drifts a few px between clients (same cause as page 1's drift —
    // widened band for tolerance). x is restricted to exclude the "NOW"
    // and "0" axis-end labels that sit at the far left/right of this same
    // row — those aren't age values. Some clients only fill 11 of the 12
    // slots (their own chart leaves the last box blank), so this can
    // legitimately return fewer than 12 numbers.
    const ageBrackets = joinSpans(inBand(sp5, 528, 552, 50, 540))
      .trim()
      .split(/\s+/)
      .filter((s) => /^\d+$/.test(s))
      .join(", ");
    fields.push({ label: "Journey Overview - age brackets", text: ageBrackets || null });
  }

  return fields;
}

export async function extractAqueraFacts(pdfBytes: Buffer | Uint8Array): Promise<Fact[]> {
  const doc = await loadDoc(pdfBytes);
  const fields: Fact[] = [];
  const pages = await indexPages(doc);

  // Every section below is located by its own printed fingerprint. The page
  // numbers that used to be here (2, 3, 5, 8, 10, 11, 12, 14) held only for
  // exports where no earlier section was missing and no paragraph had wrapped
  // an extra line; this template also appends a one-page summary at the end
  // that REPEATS several of these headings, so a naive first-match would read
  // the summary's abridged copy instead of the real section.
  const stressPage = pages.find({ match: /Stress index and sources/ });
  const p2 = stressPage === null ? "" : pages.text(stressPage);
  // Whichever of the 6 stress types appears TWICE (legend + description
  // heading) is the person's actual result; the other five appear only once.
  const activeType = STRESS_TYPES.find((t) => {
    const count = (p2.match(new RegExp(escapeRe(t), "g")) || []).length;
    return count >= 2;
  });
  if (activeType) {
    // The detail box's own stress-index number + a trailing "95%" — a
    // separate value (see below), not part of the description — always
    // sits right after the last description bullet, as "<digit(s)> <digits>%".
    // Stop there instead of the old hardcoded "94%" match, which only
    // ever matched one specific client's own number.
    fields.push({
      label: `Stress type (${activeType})`,
      text: sliceBetween(p2, new RegExp(escapeRe(activeType)), [/\s*\d{1,2}\s+\d{1,3}%\s*$/, /$/], 2),
    });

    // The detail box also has a real stress-index number (e.g. "2") in a
    // gauge graphic to the left of the title/description — it's genuinely
    // a separate value, not part of the description text, but the old
    // sliceBetween-on-plain-text approach above swallows it into the end
    // of the description blob. Find it by position: a short numeric token
    // sitting well left of the description column (x<320), within the
    // vertical span of this client's own detail box (below the box's own
    // title, above the next section).
    const sp2Stress = stressPage === null ? [] : await pageSpans(doc, stressPage);
    const titleSpan = sp2Stress.find((s) => s.x > 300 && new RegExp(`^${escapeRe(activeType.split(" ")[0])}`, "i").test(s.text));
    if (titleSpan) {
      const region = inBand(sp2Stress, titleSpan.y + 40, titleSpan.y + 130, -Infinity, 320);
      const indexSpan = region.find((s) => /^\d{1,2}$/.test(s.text));
      fields.push({ label: "Stress index value", text: indexSpan?.text ?? null });
    }
  } else {
    fields.push({ label: "Stress type", text: null });
  }

  // "Public Self" heads this page's first box; the end-of-report summary page
  // never uses that wording, so the fingerprint stays unambiguous.
  const lifePatternPage = pages.find({ match: /Public Self/ });
  const p3 = lifePatternPage === null ? "" : pages.text(lifePatternPage);
  fields.push({ label: "Public Self - note", text: sliceBetween(p3, /Public Self/, [/Personality Traits:/]) });
  fields.push({ label: "Public Self - full", text: sliceBetween(p3, /Public Self/, [/Private Self/]) });
  // "Private Self" has no separate "- note" field today the way "Public Self"
  // does — added so a client with no iEmoWave-Full upload still has a real
  // Note 2 value (their Mind Report's own Private Self note) to mark on the
  // Rhythmic Pattern chart, instead of the section just being skipped.
  fields.push({ label: "Private Self - note", text: sliceBetween(p3, /Private Self/, [/Personality Traits:/]) });
  fields.push({ label: "Private Self - full", text: sliceBetween(p3, /Private Self/, [/$/]) });

  // Match on "L & R Brain" specifically, not the bare "Emotional Processing
  // Graph" — the summary page reprints that second phrase as a chart caption.
  const lrBrainPage = pages.find({ match: /L & R Brain/ });
  const p5 = lrBrainPage === null ? "" : pages.text(lrBrainPage);
  // "Benefits of mastery:" is the fixed marker for the NEXT box down — the
  // "L R 715 725" chart-label text actually sits later in the content
  // stream than that (out of visual order), so anchoring on it swallowed
  // the whole rest of the page. Stop at "Benefits of mastery:" instead.
  fields.push({
    label: "L/R Brain - description",
    text: sliceBetween(p5, /L & R Brain - Emotional Processing Graph/i, [/Benefits of mastery:/i]),
  });
  const lr = p5.match(/L R (\d+) (\d+)/);
  fields.push({ label: "L/R Brain - values", text: lr ? `L=${lr[1]}, R=${lr[2]}` : null });

  // Page 8 is a genuine two-column layout (side-by-side "Base:" / "Next:"
  // boxes) and the PDF's own content stream interleaves the two columns —
  // reconstruct each column by x-position instead of trusting stream order.
  // Fingerprinted on "Sensory personality mode:" — the very line this section
  // slices out. A fingerprint that IS the payload can't drift apart from it,
  // and it beats the page's own "Sensory attributes" title, which the summary
  // page echoes as "Basic sensory attributes:".
  const sensoryPage = pages.find({ match: /Sensory personality mode:/ });
  const p8Left = sensoryPage === null ? "" : await columnText(doc, sensoryPage, 0, 200); // "Base:" box
  const p8Right = sensoryPage === null ? "" : await columnText(doc, sensoryPage, 200, 1000); // "Next:" box
  fields.push({
    label: "Sensory - first type (Base)",
    text: sliceBetween(p8Left, /Characteristic strengths:/, [/$/]),
  });
  fields.push({
    label: "Sensory - second type (Next)",
    text: sliceBetween(p8Right, /Characteristic strengths:/, [/$/]),
  });
  // "Sensory personality mode: The Mediator (9)" is the last line of each
  // column — pull it out on its own so it can stand in for a short
  // character label elsewhere in the report, not just live buried in the
  // full paragraph above.
  const modeM1 = /Sensory personality mode:\s*(.+)$/.exec(p8Left);
  const modeM2 = /Sensory personality mode:\s*(.+)$/.exec(p8Right);
  fields.push({ label: "Sensory personality mode (Base)", text: modeM1 ? modeM1[1].trim() : null });
  fields.push({ label: "Sensory personality mode (Next)", text: modeM2 ? modeM2[1].trim() : null });
  // "Being Introvert"/"Being Extrovert" is fixed vendor boilerplate elsewhere
  // in each column — pulled out as its own short field so Section 5's
  // Mind-Report fallback table has a stable "trait" value to show, one that
  // survives paraphrasing (short factual fields are left untouched) instead
  // of depending on where that phrase happens to land in the freely-reworded
  // prose paragraph. Gemini expands the bare word into a short descriptive
  // phrase (grounded in this same client's own paragraph) to match the
  // reference report's richer style ("Universal Love") — this runs once
  // here at upload time and the result is what gets saved, same as every
  // other Gemini-touched field, so report generation itself stays a plain
  // read with no further AI calls.
  const personaM1 = /Being (Introvert|Extrovert)/.exec(p8Left);
  const personaM2 = /Being (Introvert|Extrovert)/.exec(p8Right);
  const personaText1 = sliceBetween(p8Left, /Characteristic strengths:/, [/$/]);
  const personaText2 = sliceBetween(p8Right, /Characteristic strengths:/, [/$/]);
  const [personaPhrase1, personaPhrase2] = await Promise.all([
    personaM1 && personaText1 ? generateTraitPhrase(personaM1[1], personaText1) : Promise.resolve(personaM1?.[1] ?? null),
    personaM2 && personaText2 ? generateTraitPhrase(personaM2[1], personaText2) : Promise.resolve(personaM2?.[1] ?? null),
  ]);
  fields.push({ label: "Sensory persona (Base)", text: personaPhrase1 });
  fields.push({ label: "Sensory persona (Next)", text: personaPhrase2 });

  // The two Inner Self pages share a heading and differ only by the subtitle
  // under the character name — "(base)" is who the client is now, "(growing
  // towards)" is who they're growing into. Getting these two backwards is the
  // silent failure that motivated indexPages, so each is pinned to its own
  // subtitle and neither falls back to "the first page that says Inner Self".
  const innerSelfBasePage = pages.find({ match: /The Inner Self/, distinguishBy: /\(base\)/ });
  const p10 = innerSelfBasePage === null ? "" : pages.text(innerSelfBasePage);
  fields.push({
    label: "Inner Self (page 10) - desires/fears/beliefs",
    text: sliceBetween(p10, /The Inner Self/, [/Personality strengths:/i]),
  });
  // Case-insensitive on purpose. This page prints "Personality strengths:"
  // with a lowercase s while the Response Patterns page prints it capitalised,
  // and the case-sensitive anchor here silently cost TWO fields at once: this
  // one came back empty, and — because the same pattern is the STOP anchor for
  // the desires/fears field above — that one ran past its boundary and
  // swallowed the rest of the page (274 chars of strengths, weaknesses and
  // personality-wheel labels instead of its own 145). It was reported as
  // extracted successfully. Every heading anchor on these pages is matched
  // case-insensitively now for that reason.
  fields.push({
    label: "Inner Self (page 10) - Personality Strengths/weaknesses",
    text: sliceBetween(p10, /Personality strengths:/i, [/The Seeker/]),
  });

  const innerSelfGrowthPage = pages.find({ match: /The Inner Self/, distinguishBy: /\(growing towards\)/ });
  const p11 = innerSelfGrowthPage === null ? "" : pages.text(innerSelfGrowthPage);
  fields.push({
    label: "Inner Self (page 11) - desires/fears/beliefs",
    text: sliceBetween(p11, /The Inner Self/, [/Self-improvement:/i]),
  });
  fields.push({
    label: "Inner Self (page 11) - Self-improvement/Self-awareness",
    text: sliceBetween(p11, /Self-improvement:/i, [/The Seeker/]),
  });
  fields.push({
    label: "Inner Self (page 11) - Benefits of mastery",
    // Anchored on the heading alone. The old anchor carried the vendor's full
    // lead-in sentence ("...When you master your inner quest for character,
    // you will master the following:") which this export has already reworded
    // to "...When you deepen your inner journey, you can:" — so it matched
    // nothing and the field came back empty. Prose moves between exports;
    // headings don't.
    text: sliceBetween(p11, /Benefits of mastery:/i, [/$/]),
  });

  // Frequent/Core Emotion — the same underlying result the iEmoWave-Full
  // report calls "Frequent Emotion"/"Core Emotion", phrased here on its own
  // page with no vendor code prefix and a label that can run several words
  // long. The page prints them as two separate bordered boxes, each laid out
  // identically: the box heading ("Frequent Emotions:" / "Core Emotions:"),
  // a cartoon face, then ONE line that is the emotion's NAME ("Extrovert and
  // self-confident."), then a bullet paragraph that EXPLAINS it. The name is
  // the line ABOVE the bullet — it is not the bullet's own first sentence, and
  // the ">" some bullets carry is the vendor repeating the name inline, not a
  // reliable name/description separator: the Core box routinely omits it.
  //
  // Read by span position rather than normalizedPageText. That helper joins
  // pdf.js items in raw content-stream order, which these boxes do not follow
  // (the hazard columnText documents) — the Core box's bullet has been observed
  // landing inside a slice that should have stopped at the "Core Emotions:"
  // heading, which is how a client's Core emotion printed the wrong text with
  // its description blank. Positions are what the page actually looks like.
  //
  // Locating this page needs the disambiguator, because the report's final
  // summary page reprints BOTH "Frequent Emotions:" and "Core Emotions:" with
  // its own shorter rewording of each ("Socially confident and outgoing."
  // where the real section says "Confident, outgoing, and affectionate. May
  // enjoy attention and romantic connection."). Only the real section sits
  // under the "Key Emotions" title, so that is what tells them apart — without
  // it, a first-match search is a coin flip that silently downgrades every
  // client's emotion text to the summary's abridged copy.
  const CORE_HEADING = /^Core Emotions\s*:/i;
  const keyEmotionsPage = pages.find({ match: /Frequent Emotions\s*:/, distinguishBy: /Key Emotions/ });
  const emotionLines = keyEmotionsPage === null ? [] : pageLines(await pageSpans(doc, keyEmotionsPage));
  // The two boxes are tall; on some clients the Core box is pushed onto the
  // following page entirely, so pull that page in too when its heading isn't
  // here. Appending is safe — boxFrom only ever reads forward from a heading.
  if (keyEmotionsPage !== null && !emotionLines.some((l) => CORE_HEADING.test(l.text)) && keyEmotionsPage + 1 <= pages.count) {
    emotionLines.push(...pageLines(await pageSpans(doc, keyEmotionsPage + 1)));
  }

  // One box's content lines: everything below its heading, stopping at the
  // next box's heading so the two can never bleed into each other.
  const boxFrom = (heading: RegExp, stopAt: RegExp[]): string[] => {
    const start = emotionLines.findIndex((l) => heading.test(l.text));
    if (start < 0) return [];
    let end = emotionLines.length;
    for (let i = start + 1; i < emotionLines.length; i++) {
      if (stopAt.some((re) => re.test(emotionLines[i].text))) {
        end = i;
        break;
      }
    }
    return emotionLines
      .slice(start + 1, end)
      .map((l) => l.text)
      .filter(Boolean);
  };

  // Split a box into its name line(s) and its bullet paragraph. pdf.js
  // reliably renders the bullet as a real "•" (U+2022), so that glyph is the
  // boundary: everything before it is the name, everything from it on is the
  // explanation. A box with no bullet at all yields a name and no
  // explanation rather than guessing which half of the text is which.
  const parseEmotionBox = (lines: string[]): { label: string; desc: string } => {
    const bulletAt = lines.findIndex((l) => l.includes("•"));
    const nameLines = bulletAt < 0 ? lines : lines.slice(0, bulletAt);
    const bodyLines = bulletAt < 0 ? [] : lines.slice(bulletAt);
    let label = nameLines.join(" ").replace(/\s+/g, " ").trim();
    let desc = bodyLines
      .join(" ")
      .replace(/\s*•\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // "Feels weak and powerless in some situations.> Some topics or subjects
    // can weaken..." — the bullet often opens by repeating the name inline
    // before ">". Two jobs here: drop that repeat so the description doesn't
    // restate the name printed above it, and — for the older layout that
    // prints bullets with no name line of their own — use it AS the name,
    // which is the only place that layout states it.
    const repeated = /^(.+?)>\s*(.*)$/s.exec(desc);
    if (repeated && repeated[2].trim()) {
      if (!label) label = repeated[1].trim();
      desc = repeated[2].trim();
    }
    return { label, desc };
  };

  const freqBox = parseEmotionBox(boxFrom(/^Frequent Emotions\s*:/i, [CORE_HEADING]));
  const coreBox = parseEmotionBox(boxFrom(CORE_HEADING, [/^Frequent Emotions\s*:/i]));

  fields.push({ label: "Frequent Emotion (Mind Report)", text: freqBox.label || null });
  fields.push({ label: "Frequent Emotion (Mind Report) - description", text: freqBox.desc || null });
  fields.push({ label: "Core Emotion (Mind Report)", text: coreBox.label || null });
  fields.push({ label: "Core Emotion (Mind Report) - description", text: coreBox.desc || null });

  // The 7 vortex rows ("[7] Crown Energy [B] 129 Too High") sit as one
  // clean line per row in the content stream, but the bar-chart's own axis
  // tick labels ("Too High High Balance Low Too Low") and category labels
  // print elsewhere on the page and would corrupt a naive linear read — so
  // this reads real (x,y) positions and only trusts the row band where the
  // "[N]" markers actually live, same principle as the iEmoWave-Full
  // numbered-row tables.
  const vortexPage = pages.find({ match: /Overall Vortex Energy/ });
  const sp14 = vortexPage === null ? [] : await pageSpans(doc, vortexPage);
  const vortexRegion = inBand(sp14, 195, 430);
  const vortexRows: Span[][] = [];
  for (const s of vortexRegion.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = vortexRows[vortexRows.length - 1];
    if (last && Math.abs(s.y - last[0].y) <= 5) last.push(s);
    else vortexRows.push([s]);
  }
  for (const row of vortexRows) {
    const text = joinSpans(row.slice().sort((a, b) => a.x - b.x));
    const m = /^\[(\d)\]\s+(.+?)\s+\[([^\]]+)\]\s+(\d+)\s+(Too High|Too Low|Balance|High|Low)$/.exec(text);
    if (!m) continue;
    // Client asked for a High/Low scale without "Too" qualifiers.
    const simplified = m[5].replace(/^Too\s+/i, "");
    fields.push({
      label: `Vortex Energy - Row ${m[1]}`,
      text: `${m[2]} [${m[3]}] — ${simplified} (${m[4]})`,
    });
  }

  return fields;
}

export async function extractEmotionalNotesFacts(pdfBytes: Buffer | Uint8Array): Promise<Fact[]> {
  const doc = await loadDoc(pdfBytes);
  const fields: Fact[] = [];

  // This template's page COUNT varies per export (10, 12, and more have all
  // been seen) because its optional sections come and go, which shifts every
  // page after the missing one. So nothing here may address a page by number:
  // each section is located by its own heading, exactly as the category loop
  // below already does. Read every page's text once up front — a dozen short
  // pages — and look sections up in that.
  const pages = await indexPages(doc);
  // Every page ends with its own "Page: N Date: ..." footer, so a section
  // slice stops at the footer rather than at a hardcoded "Page: 3" — the
  // number in it is precisely the thing that moves.
  const PAGE_FOOTER = /Page:\s*\d+/;

  const lrBrainPage = pages.find({ match: /L & R Brain - Emotional Processing Graph/ });
  fields.push({
    label: "Personality description",
    text:
      lrBrainPage === null
        ? null
        : sliceBetween(
            pages.text(lrBrainPage),
            /indicates an autonomous personality\. One prefers to decide for yourself what to think and what to do\./,
            [PAGE_FOOTER],
          ),
  });

  // "Note Balance" chart — its per-note numbers are baked into the image
  // itself (page 3), not selectable text. Fallback data source for Journey
  // Overview when there's no iEmoWave-Full upload (whose own Code/Value
  // table is unavailable without it). Stored in the same "NN. code=value"
  // format as that table so the renderer can parse both the same way.
  //
  // Always push a field for this (even on failure) — previously a failed
  // read pushed nothing at all, so it silently vanished from the extraction
  // log instead of showing up as "!! NOT FOUND !!" like every other field,
  // which is exactly how one client's missing Journey Overview chart went
  // unnoticed for a week. Logging which of the two failure modes happened
  // (no image on the page vs. Gemini couldn't read it) so the next one is
  // diagnosable from the server log alone, not by re-deriving it by hand.
  const noteBalanceImage = lrBrainPage === null ? null : await extractWidestAspectImage(doc, lrBrainPage);
  if (!noteBalanceImage) {
    console.error(
      lrBrainPage === null
        ? "Note Balance chart: no 'L & R Brain' page found in this report."
        : `Note Balance chart: no image found on page ${lrBrainPage}.`,
    );
    fields.push({ label: "Note Balance - values", text: null });
  } else {
    const values = await readNoteBalanceChart(noteBalanceImage);
    if (!values) {
      console.error(`Note Balance chart: image found on page ${lrBrainPage} but Gemini Vision could not read it.`);
      fields.push({ label: "Note Balance - values", text: null });
    } else {
      const pairs = NOTE_SCALE_ORDER.map((code, i) => `${String(i + 1).padStart(2, "0")}. ${code}=${values[i]}`).join(", ");
      fields.push({ label: "Note Balance - values", text: pairs });
    }
  }

  const ninePointsPage = pages.find({ match: /9 Points Type/ });
  fields.push({
    label: "9 Points Type summary",
    text: ninePointsPage === null ? null : sliceBetween(pages.text(ninePointsPage), /9 Points Type/, [PAGE_FOOTER]),
  });

  // Each category page has a numbered list of Constructive/Restrictive
  // trait items — count in its own column, "C - text" or "R - text" in the
  // next column over, same row. pdf.js keeps these as two clean separate
  // spans per row (unlike most of this file's tables, no reading-order fix
  // needed here), so a straight per-row x-split is enough.
  //
  // These 6 categories are NOT always all present, and when some are
  // missing the rest shift up — confirmed against two real exports for the
  // same client: one had Personality/Emotional/Impulsive at pages 6-8 (9
  // pages total), the other had Mirrored Perception/Rational at pages 6-7
  // (8 pages total). Assuming a fixed page-per-category used to crash the
  // whole upload with pdf.js's own "Invalid page request" the moment a
  // report had fewer than 11 pages — every page now gets checked by its
  // own heading instead of trusted by position, so a
  // category that's on the "wrong" page still gets found under the right
  // label, and one that's genuinely absent from this report shows as
  // "not found" rather than crashing or (worse) mislabeling a different
  // category's content as this one.
  const CATEGORY_HEADING_PATTERNS: [string, RegExp][] = [
    ["Personality", /^Personality\b/i],
    ["Mirrored Perception", /^Mirrored\s+Perception\b/i],
    ["Emotional", /^Emotional\b/i],
    ["Impulsive", /^Impulsive\b/i],
    ["Rational", /^Rational\b/i],
    ["Social", /^Social\b/i],
  ];
  //
  // Scanning starts at page 1 rather than a fixed page 6, since the front
  // matter shifts too. What keeps the earlier pages from false-matching is
  // CATEGORY_PIE_LEGEND: only a real category page carries the "26 C - 45 R -"
  // pie legend. The guard has to key on the R half specifically — the "C -"
  // half also appears in the page footer every one of these pages shares
  // ("Page: 5 C - Constructive emotions and R - Restrictive emotions"), where
  // the page NUMBER sits right before "C -" and matches a digits-then-"C -"
  // test. Nothing puts digits before that footer's "R -".
  const CATEGORY_PIE_LEGEND = /\d+\s+R\s*-/;
  const foundCategories = new Map<string, string>(); // label -> extracted text (or "" for found-but-empty)
  for (let pno = 1; pno <= pages.count; pno++) {
    const heading = pages.text(pno);
    if (!CATEGORY_PIE_LEGEND.test(heading)) continue;
    const match = CATEGORY_HEADING_PATTERNS.find(([, pat]) => pat.test(heading));
    if (!match) continue;
    const [label] = match;
    if (foundCategories.has(label)) continue; // first match wins if a heading somehow repeats

    const spans = await pageSpans(doc, pno);
    const region = inBand(spans, 460, 790);
    const rows: Span[][] = [];
    for (const s of region.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(s.y - last[0].y) <= 3) last.push(s);
      else rows.push([s]);
    }
    const items: string[] = [];
    for (const row of rows) {
      const countSpan = row.find((s) => s.x < 60 && /^\d+$/.test(s.text));
      const textSpan = row.find((s) => s.x >= 60);
      if (!countSpan || !textSpan) continue;
      const m = /^([CR])\s*-\s*(.+?)\s*>?$/.exec(textSpan.text.trim());
      // The single highest-ranked item on the page has no "C -"/"R -"
      // prefix at all (it's this category's single standout trait, shown
      // above the ranked breakdown) — keep it, just without a type letter.
      items.push(m ? `${countSpan.text} ${m[1]} - ${m[2]}` : `${countSpan.text} - ${textSpan.text.trim().replace(/\s*>$/, "")}`);
    }
    foundCategories.set(label, items.join("\n"));
  }
  for (const [label] of CATEGORY_HEADING_PATTERNS) {
    const text = foundCategories.get(label);
    fields.push({ label: `${label} - trait scores`, text: text ? text : null });
  }

  return fields;
}

function titleCase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Pulls the client's actual name off page 1, so multiple reports for the
// same person (Aquera + Emotional Notes + iEmoWave Full) can be linked to
// one assessment instead of the uploaded filename standing in for identity —
// each of the 3 known templates prints the name slightly differently.
function extractClientName(template: string, p1: string): string | null {
  // Names occasionally start with a digit (e.g. an org code like "001GMA
  // Fatima") — allow leading alphanumerics, not just letters.
  if (template === "iEmoWave Full") {
    const m = /Name:\s*([A-Za-z0-9][A-Za-z0-9\s'.-]*?)\s*Date:/i.exec(p1);
    return m ? titleCase(m[1]) : null;
  }
  if (template === "Emotional Notes") {
    const m = /^([A-Za-z0-9][A-Za-z0-9\s'.-]*?)\s+\d{4}-\d{2}-\d{2}/i.exec(p1);
    return m ? titleCase(m[1]) : null;
  }
  if (template === "Aquera Mind Report") {
    const m = /Date:\s*([A-Za-z0-9][A-Za-z0-9\s'.-]*?)\s+\d{4}-\d{2}-\d{2}/i.exec(p1);
    return m ? titleCase(m[1]) : null;
  }
  return null;
}

/** Peeks page 1 to decide which known template this PDF is, then extracts. */
// Fields that ARE Gemini output from the moment they're created (a
// generated trait phrase, a Vision-read chart) rather than vendor text that
// gets rewritten — there's no "raw" version of these to keep in ReportFact,
// so they route straight into `enhanced` instead of through paraphraseFacts.
const DIRECTLY_GENERATED_LABELS = new Set(["Sensory persona (Base)", "Sensory persona (Next)", "Note Balance - values"]);

export async function extractTemplateFacts(
  pdfBytes: Buffer | Uint8Array,
): Promise<{ template: string; fields: Fact[]; enhanced: Record<string, string>; clientName: string | null }> {
  const doc = await loadDoc(pdfBytes);
  const p1 = await normalizedPageText(doc, 1);

  let result: { template: string; fields: Fact[] };
  // Matches both "iEmoWave Full" and "EmoWave Full" — the client's vendor
  // apparently prints the "i" prefix inconsistently across exports, but
  // "EmoWave Full" is a substring of "iEmoWave Full" so one check covers both.
  if (/EmoWave\s*Full/i.test(p1)) {
    result = { template: "iEmoWave Full", fields: await extractEwFullFacts(pdfBytes) };
  } else if (/Emotional Notes/i.test(p1)) {
    result = { template: "Emotional Notes", fields: await extractEmotionalNotesFacts(pdfBytes) };
  } else if (/Mind\s*Report/i.test(p1)) {
    result = { template: "Aquera Mind Report", fields: await extractAqueraFacts(pdfBytes) };
  } else {
    throw new Error("Unrecognized report template — page 1 didn't match a known layout.");
  }

  const directEnhanced: Record<string, string> = {};
  const rawOnlyFields: Fact[] = [];
  for (const f of result.fields) {
    if (f.text && DIRECTLY_GENERATED_LABELS.has(f.label)) {
      directEnhanced[f.label] = f.text;
    } else {
      rawOnlyFields.push(f);
    }
  }

  // The final report must not reproduce the source vendor PDF's own
  // sentences verbatim — rewrite every prose-length field in original
  // wording before it's ever saved. `raw` (untouched vendor text) is what
  // goes to ReportFact; `enhanced` (the rewrites, plus the directly
  // generated fields above) goes to the section-specific "*Content" tables.
  const { raw, enhanced } = await paraphraseFacts(rawOnlyFields);

  return {
    template: result.template,
    fields: raw,
    enhanced: { ...enhanced, ...directEnhanced },
    clientName: extractClientName(result.template, p1),
  };
}
