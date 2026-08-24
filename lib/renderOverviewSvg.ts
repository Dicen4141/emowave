import { readFileSync } from "node:fs";
import path from "node:path";
import { NOTE_SCALE } from "./renderEwFullReport";

// The client's own reference design (public/report-templates/emowave-overview.svg)
// is the ENTIRE visual layout — every panel, icon, color, header, and chart grid
// in the output comes from that file, unmodified. This module's only job is to
// lay real per-client text and marks on top of it, at coordinates read directly
// out of that same file (via a one-time DOM inspection — see the coordinates
// below), not to redraw or approximate the design with hand-built CSS/HTML.
const TEMPLATE_PATH = path.join(process.cwd(), "public", "report-templates", "emowave-overview.svg");

let cachedTemplate: string | null = null;
function loadTemplateSvg(): string {
  if (!cachedTemplate) cachedTemplate = readFileSync(TEMPLATE_PATH, "utf8");
  return cachedTemplate;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// SVG has no text auto-wrap — approximate word-wrap by character count (avg
// glyph width ~0.52em, close enough at report scale) into a fixed number of
// <tspan> lines, ellipsizing rather than overflowing the box it's placed in.
function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (words.join(" ").length > lines.join(" ").length && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.replace(/.{0,3}$/, "").trimEnd() + "…";
  }
  return lines;
}

// Advance width in em for ASCII 32..126, measured off Segoe UI itself — the
// first font in tspanBlock's stack — rather than estimated per character
// class. Estimating by class is what put text outside the Emotional Pattern
// cards: grouping glyphs into "narrow/wide/upper/lower" underestimated real
// prose by up to 4.7%, which on a 478-wide card is ~9 units of text printed
// past the card edge. SVG text is drawn over the template and is never
// clipped, so an overrun is visible, not silently cut. Against this table the
// same lines predict within 0.3%.
//
// To regenerate: render <text> at a large font-size and take
// getComputedTextLength("H<c>H") - getComputedTextLength("HH") for each char.
// Flanking with H matters — a lone leading/trailing space collapses in SVG
// and measures as ~0, which is exactly how the old space value went wrong.
// prettier-ignore
const GLYPH_EM = [
  0.274, 0.284, 0.392, 0.591, 0.539, 0.818, 0.800, 0.230, 0.302, 0.302, 0.417, 0.684, 0.217, 0.400, 0.217, 0.390,
  0.539, 0.539, 0.539, 0.539, 0.539, 0.539, 0.539, 0.539, 0.539, 0.539, 0.217, 0.217, 0.684, 0.684, 0.684, 0.448,
  0.955, 0.645, 0.573, 0.619, 0.701, 0.506, 0.488, 0.686, 0.710, 0.266, 0.357, 0.580, 0.471, 0.898, 0.748, 0.754,
  0.560, 0.754, 0.598, 0.531, 0.524, 0.687, 0.621, 0.934, 0.590, 0.553, 0.570, 0.302, 0.379, 0.302, 0.684, 0.415,
  0.268, 0.509, 0.588, 0.462, 0.589, 0.523, 0.313, 0.589, 0.566, 0.242, 0.242, 0.497, 0.242, 0.861, 0.566, 0.586,
  0.588, 0.589, 0.348, 0.424, 0.339, 0.566, 0.479, 0.723, 0.459, 0.484, 0.452, 0.302, 0.239, 0.302, 0.684,
];
const ELLIPSIS_EM = 0.733;
// Curly quotes, dashes and accented letters all come in under this; rounding
// non-ASCII up costs a few units of line fill and can only wrap early, never
// overflow.
const NON_ASCII_EM = 0.6;

function glyphEm(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 32 && code <= 126) return GLYPH_EM[code - 32];
  return c === "…" ? ELLIPSIS_EM : NON_ASCII_EM;
}

function textWidth(s: string, fontSize: number): number {
  let em = 0;
  for (const c of s) em += glyphEm(c);
  return em * fontSize;
}

/**
 * A word with no break opportunity that is itself wider than the line can
 * never be placed safely — wrapping alone would leave it sticking out of the
 * box. Chop those into line-width fragments up front so the wrapper only ever
 * sees words it can actually fit. Rare in prose, but this runs over whatever
 * text each client's report happens to contain, so it can't assume prose.
 */
function splitOverlongWords(words: string[], maxWidth: number, fontSize: number): string[] {
  const out: string[] = [];
  for (const w of words) {
    if (textWidth(w, fontSize) <= maxWidth) {
      out.push(w);
      continue;
    }
    let cur = "";
    for (const ch of w) {
      if (cur && textWidth(cur + ch, fontSize) > maxWidth) {
        out.push(cur);
        cur = ch;
      } else {
        cur += ch;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Word-wrap to a pixel width instead of a character count, ellipsizing the
 * last line when the text doesn't fit. The ellipsis is trimmed back by
 * measured width too — appending "…" to a line already at the budget would
 * itself overflow, which is exactly the bug the character version had.
 */
function wrapToWidth(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const words = splitOverlongWords((text || "").trim().split(/\s+/).filter(Boolean), maxWidth, fontSize);
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (cur && textWidth(next, fontSize) > maxWidth) {
      lines.push(cur);
      cur = words[i];
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  const truncated = lines.length === maxLines && (i < words.length || cur !== "");
  if (lines.length < maxLines && cur) lines.push(cur);
  if (truncated && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last && textWidth(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.trimEnd() + "…";
  }
  return lines;
}

// Emotional Pattern body sizing. The card is a fixed box, so a long
// description can't have both the largest body size and its last sentence —
// at 14 a 338-character description loses ~35 characters, at 12 it fits whole.
// Rather than truncating every long card at one fixed size, step the size down
// only when the text needs it: most clients keep 14 and the occasional long
// one shrinks slightly instead of losing a sentence. 12 is the floor; below
// that the text is harder to read than the dropped tail is worth, so the
// smallest size ellipsizes as before.
const PATTERN_BODY_W = 478;
// Title pulled back to 15 so the body can have the room instead: it's the
// description people read, and the label is already carried by weight and
// colour rather than needing size too. Every unit off the title is a unit the
// body ladder can start higher from.
// Note the ladder now tops out ABOVE the title size — a short description
// renders at 18 under a 15 title, which inverts the usual size hierarchy.
// That's deliberate (bigger description was the ask); bold purple against
// regular grey is what keeps the label reading as a label. Cap the first
// entry at 15 to restore the conventional order.
const PATTERN_TITLE_SIZE = 15;
const PATTERN_TITLE_BASELINE = 634;
const PATTERN_BODY_SIZES = [18, 17, 16, 15, 14, 13, 12];
const PATTERN_FIRST_BASELINE = 653;
const PATTERN_MAX_BASELINE = 716.5; // descenders stay inside the card bottom (724.5)

/**
 * Both cards are sized together, not independently: they sit side by side, so
 * a 14 left card next to a 12 right one reads as a rendering fault rather than
 * as a fit. The pair takes the largest size at which BOTH descriptions fit
 * whole — which does mean a short description shrinks to keep its partner
 * company. Size them separately by calling this per card if that trade ever
 * looks wrong.
 */
function fitPatternPair(freqDesc: string, coreDesc: string): {
  fontSize: number;
  leading: number;
  freq: string[];
  core: string[];
} {
  const linesFor = (fontSize: number, leading: number) =>
    Math.floor((PATTERN_MAX_BASELINE - PATTERN_FIRST_BASELINE) / leading) + 1;
  const complete = (lines: string[]) => lines.length === 0 || !lines[lines.length - 1].endsWith("…");

  let fallback!: { fontSize: number; leading: number; freq: string[]; core: string[] };
  for (const fontSize of PATTERN_BODY_SIZES) {
    const leading = fontSize * 1.25;
    const maxLines = linesFor(fontSize, leading);
    const freq = wrapToWidth(freqDesc, PATTERN_BODY_W, fontSize, maxLines);
    const core = wrapToWidth(coreDesc, PATTERN_BODY_W, fontSize, maxLines);
    fallback = { fontSize, leading, freq, core };
    if (complete(freq) && complete(core)) return fallback;
  }
  return fallback;
}

function tspanBlock(
  x: number,
  y: number,
  lines: string[],
  lineHeight: number,
  fontSize: number,
  color: string,
  weight = 400,
  anchor: "start" | "middle" = "start",
): string {
  return `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" font-family="'Segoe UI', Arial, sans-serif" text-anchor="${anchor}">${lines
    .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${esc(l)}</tspan>`)
    .join("")}</text>`;
}

// Coordinates below are read directly from emowave-overview.svg's own DOM
// (getBBox()/getScreenCTM() per element, resolved into the root <svg>'s
// viewBox space) — not estimated or hand-designed. viewBox is
// "0 0 1190.25 1683.749949".
// Left edge of the left column's own captions in the template ("accumulated
// emotional stress", "brain activities") — the values printed under each of
// them line up on it.
const CAPTION_X = 119.82;
// Header's Report No. The template draws the "REPORT NO:" label itself, so
// only the value is overlaid. Both coordinates are read off the template's
// own outlines: its label's last glyph (the colon) sits at x 438.68 on the
// DATE row, and DATE: puts its value 13.2 after its own colon (86.79 -> 100),
// so the same offset lands the value here. The baseline is the one the DATE
// value uses, so the two header values sit on one line.
const REPORT_NO_VALUE_X = 451.9;
const REPORT_NO_BASELINE = 96;
const NOTE_COL_X0 = 456.6;
const NOTE_COL_STEP = 60.47;
const NOTE1_ROW_Y = 839.7;
const NOTE2_ROW_Y = 877.7;
const noteColX = (i: number) => NOTE_COL_X0 + NOTE_COL_STEP * i;

const BP_COL_X0 = 70;
const BP_COL_STEP = 54.05;
// Measured directly off the file's own red/orange/green band rects: red
// spans y 1144-1197.9, orange 1198-1249.7, green 1249.7-1327.3 — top of red
// to bottom of green is 183.3 units over 7 rows.
const BP_ROW_TOP = 1144; // level 7 row top
const BP_ROW_H = 183.3 / 7; // level 7..1, top to bottom
const bpColX = (i: number) => BP_COL_X0 + BP_COL_STEP * i;
const bpRowY = (level: number) => BP_ROW_TOP + (7 - level) * BP_ROW_H + BP_ROW_H / 2;

const EXCELLENCY_ROWS = [1144.2, 1205, 1265.8, 1326.5, 1387.3, 1448.1, 1508.9].map((y) => ({ x: 733.1, y, w: 272, h: 50.5 }));

// Emotion wheel's 12 note-bubble centers, read the same way as everything
// else — getBBox() on each colored circle. Fitting a true circle center to
// the 12 measured points (rather than a plain average, which skews when tips
// and boundary notes sit at different radii) put all 12 within a tight
// ~142-unit radius band, confirming the fit — and against that center, 8
// points cluster on exact 45deg multiples (0,45,90...315) and the other 4 on
// the odd-22.5 midpoints between specific pairs of those (112.5, 247.5,
// 292.5, 337.5), matching the wheel's 8 petal tips (45deg apart) plus 4
// boundary notes at the midpoint between two specific adjacent tips — e.g.
// E sits exactly between the D# tip (90deg) and D tip (135deg) at 112.5deg.
// (An earlier version of this map had tips and boundaries swapped, which
// rotated every note's assigned bubble by one position — this one is
// verified against that fit, not just internally consistent with itself.)
const WHEEL_NOTE_POS: Record<string, { x: number; y: number }> = {
  C: { x: 200.9, y: 751 },
  "C#": { x: 301.3, y: 795.1 },
  "D#": { x: 342.6, y: 895.7 },
  E: { x: 331.1, y: 948.2 },
  D: { x: 298, y: 994.2 },
  F: { x: 200.9, y: 1033.8 },
  "F#": { x: 101.4, y: 994.2 },
  G: { x: 69.8, y: 955.7 },
  "G#": { x: 64, y: 895.7 },
  A: { x: 69.8, y: 834.6 },
  "A#": { x: 96.7, y: 791.7 },
  B: { x: 138.8, y: 763.4 },
};

// Shared by the full-page overlay below and the cropped Behaviour Pattern
// fragment (renderBehaviourPatternFragment) — same "this one" treatment
// wherever the wheel/note-scale appear, drawn once so both stay identical.
function markDiamond(cx: number, cy: number): string {
  const r = 9;
  const d = `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
  return `<path d="${d}" fill="#1f2937" stroke="#ef7622" stroke-width="2" stroke-linejoin="round" />`;
}
// Every note's own real color in the template, measured directly off the
// file (hit-tested at each note's known center, sampled at several offsets
// to avoid landing on the letter glyph itself — see the note position
// comment above for how positions were derived the same way). The 8
// petal-owning notes (C, C#, D#, D, F, F#, G#, A#) are fully saturated; the
// 4 seam notes (B, A, G, E) are already a paler tint of their neighbor.
const NOTE_FILL: Record<string, string> = {
  C: "#ffff53",
  "C#": "#53ff55",
  "D#": "#009600",
  E: "#c5e1c5",
  D: "#5abdff",
  F: "#5151ff",
  "F#": "#ff54ff",
  G: "#ffc5ff",
  "G#": "#d40100",
  A: "#ffc58c",
  "A#": "#ffc48c",
  B: "#ffff55",
};

// Perceptive luminance (ITU-R BT.601) — picks readable text color per note
// instead of one fixed color that would wash out on the light notes (C,
// B, A, A#...) or the dark ones (D#, F, G#) alike.
function textColorFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1f2937" : "#ffffff";
}

// A/G/E's own outward template labels ("aggressiveness", "contempt", "awe")
// sit closer to their note bubble than every other note's label does — the
// template art isn't perfectly symmetric label-to-label, so the default
// r=17 alone covers part of those specific words (confirmed by rendering
// all 12 notes at high zoom and checking every one individually, not just
// the ones originally reported). Moving those circles off their normal spot
// on the wheel's own ring was tried first and worked, but then looks
// inconsistent against the other 10 notes that stay exactly on the ring —
// shrinking just these three instead keeps every circle centered in its
// template position, just not quite as enlarged for these three. Radii
// found by rendering each step and checking the label was fully clear.
const RADIUS_OVERRIDE: Record<string, number> = { A: 15, G: 14.5, E: 13 };

// The client's own note(s) get a bigger circle in their own real color,
// drawn on top of the template — every other note is left exactly as the
// template draws it (no graying, no dimming), so "this one" reads purely
// from size, not by muting everything else.
function emphasizeSelectedWheelNotes(activeNotes: string[]): string {
  // r=22 (an earlier attempt) grew past the template's own dashed reference
  // circle and started covering the petal labels next to it (e.g. "D#"
  // blocking "apprehension") — 17 is a real, visible size bump over the
  // template's own ~14.5 without reaching either.
  const DEFAULT_R = 17;
  const marks: string[] = [];
  for (const note of activeNotes) {
    const p = WHEEL_NOTE_POS[note];
    const fill = NOTE_FILL[note];
    if (!p || !fill) continue;
    const r = RADIUS_OVERRIDE[note] ?? DEFAULT_R;
    marks.push(`<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="#1f2937" stroke-width="1.5" />`);
    marks.push(
      `<text x="${p.x}" y="${p.y}" font-size="15" font-weight="800" fill="${textColorFor(fill)}" font-family="'Segoe UI', Arial, sans-serif" text-anchor="middle" dominant-baseline="central">${note}</text>`,
    );
  }
  return marks.join("\n");
}

// The Behaviour Pattern region (wheel + note scale + genre pills + pace
// bars, including its own section header) cropped straight out of the same
// reference file the Overview page uses — measured directly off the file
// (bounding box of every element in that band): x 52.5-1150.1, y
// 739.5-1045.3, padded a little on each side. Same technique as the
// Overview page (the file's own artwork, not a redrawn CSS recreation) —
// just a viewBox crop into one section's worth of it instead of the whole
// page, for use inside the full report's flowing section-by-section layout.
const BEHAVIOUR_CROP = { x: 40, y: 725, w: 1120, h: 330 };

/**
 * Renders the Behaviour Pattern section (wheel + note scale) as a
 * self-contained HTML fragment, cropped from the real reference SVG with
 * the client's own note 1/2 marked on it — for embedding inside the full
 * multi-section report in place of the old hand-drawn emotionWheelSvg() /
 * noteScaleHtml() functions.
 */
export function renderBehaviourPatternFragment(note1: string, note2: string): string {
  const template = loadTemplateSvg();
  const crop = BEHAVIOUR_CROP;
  const aspect = crop.h / crop.w;
  const background = template.replace(
    /<svg /,
    `<svg viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" style="position:absolute;top:0;left:0;width:100%;height:100%" `,
  );

  const marks: string[] = [];
  const idx1 = NOTE_SCALE.indexOf(note1);
  const idx2 = NOTE_SCALE.indexOf(note2);
  if (idx1 >= 0) marks.push(markDiamond(noteColX(idx1), NOTE1_ROW_Y));
  if (idx2 >= 0) marks.push(markDiamond(noteColX(idx2), NOTE2_ROW_Y));
  marks.push(emphasizeSelectedWheelNotes([note1, note2].filter(Boolean)));

  return `<div style="position:relative;width:100%;padding-top:${(aspect * 100).toFixed(2)}%">
    ${background}
    <svg viewBox="${crop.x} ${crop.y} ${crop.w} ${crop.h}" style="position:absolute;top:0;left:0;width:100%;height:100%" xmlns="http://www.w3.org/2000/svg">
      ${marks.join("\n")}
    </svg>
  </div>`;
}

// "top 5: empowering / dis-empowering" — the two lists at the bottom of the
// left panel. Laid out as shared rows rather than a fixed y-step per item:
// with a fixed step, an item that wrapped to two lines ate its own trailing
// gap and the one below it sat visibly tighter than the rest. Here every row
// advances by its own tallest column plus one constant gap, so the space
// between items reads as equal down both columns and row i stays level across
// the two of them.
// First baseline sits 27 under the template's own header row (both "top 5:"
// labels are one text run at y=1408.9) — close to the 34 the items themselves
// step by, rather than the 51 of dead space that reads as a broken gap.
const TOP5_Y0 = 1436;
const TOP5_MAX_Y = 1645; // panel bottom is 1652.4 — last baseline stops short of it
const TOP5_LINE_H = 14;
const TOP5_BULLET_GAP = 16; // bullet column -> text column, so wrapped lines hang
const TOP5_COLS = [48, 395];

function renderTopFiveLists(constructive: string[], restrictive: string[]): string[] {
  const cols = [constructive.slice(0, 5), restrictive.slice(0, 5)];
  const rowCount = Math.max(...cols.map((c) => c.length));
  if (rowCount === 0) return [];

  // Wrap first: the row heights (and so the gap that fits) depend on how many
  // lines each item actually takes.
  const wrapped = cols.map((col) =>
    Array.from({ length: rowCount }, (_, i) => (col[i] ? wrapLines(col[i], 36, 2) : [])),
  );
  const rowLines = Array.from({ length: rowCount }, (_, i) =>
    Math.max(1, ...wrapped.map((col) => col[i].length)),
  );

  // Prefer a 20-unit gap, but give the lines themselves priority — when enough
  // items wrap the gap shrinks to keep the last row inside the panel.
  const lineSpan = (rowLines.reduce((a, b) => a + b, 0) - 1) * TOP5_LINE_H;
  const gaps = Math.max(1, rowCount - 1);
  const gap = Math.max(8, Math.min(20, (TOP5_MAX_Y - TOP5_Y0 - lineSpan) / gaps));

  const out: string[] = [];
  let y = TOP5_Y0;
  rowLines.forEach((lines, i) => {
    wrapped.forEach((col, c) => {
      if (!col[i].length) return;
      const x = TOP5_COLS[c];
      // ◆ renders noticeably larger than a square/round bullet at the same
      // size, so it runs a couple of points smaller to keep the same weight
      // against the 15px item text.
      out.push(tspanBlock(x, y, ["◆"], 0, 11, "#1f2328", 700));
      out.push(tspanBlock(x + TOP5_BULLET_GAP, y, col[i], TOP5_LINE_H, 15, "#1f2328"));
    });
    y += lines * TOP5_LINE_H + gap;
  });
  return out;
}

export type OverviewSvgData = {
  name: string;
  date: string;
  reportNo: string;
  stressScore: string; // iEmoWave-Full 0-100 scale, "" if absent
  stressIndex: string; // Mind Report scale, "" if absent
  lrBrain: { left: string; right: string } | null;
  freqLabel: string;
  freqDesc: string;
  coreLabel: string;
  coreDesc: string;
  presentCharacterName: string;
  realIntentionName: string;
  baseAttrs: string[];
  nextAttrs: string[];
  note1: string;
  note2: string;
  dynamics: { label: string; rating: string }[]; // 7 leadership dynamics, already-simplified rating
  constructive: string[];
  restrictive: string[];
  journeyValues: number[]; // 12 values 1-7, [] if none
  journeyAges: string[]; // 12 age-bracket labels for the checkbox row below, [] if none
};

export function renderOverviewSvgHtml(data: OverviewSvgData): string {
  const template = loadTemplateSvg();
  // The template declares its own width/height/viewBox — force it to fill its
  // wrapper 1:1 with the viewBox (its own natural page size) rather than the
  // pixel width/height Figma exported, which are a display scale factor, not
  // the coordinate space the coordinates above were measured in.
  const svgBackground = template.replace(
    /<svg /,
    `<svg style="position:absolute;top:0;left:0;width:1190.25px;height:1683.75px" `,
  );

  const overlays: string[] = [];

  overlays.push(tspanBlock(112, 63, [data.name || "—"], 0, 15, "#1f2328", 700));
  overlays.push(tspanBlock(100, 96, [data.date || "—"], 0, 15, "#1f2328", 700));
  // Report No. sits on the DATE row, to its right. The "REPORT NO:" label is
  // part of the template's own artwork, so only the value goes on top of it.
  overlays.push(tspanBlock(REPORT_NO_VALUE_X, REPORT_NO_BASELINE, [data.reportNo || "—"], 0, 15, "#1f2328", 700));

  const ratingClass = (r: string) => {
    const v = r.toLowerCase();
    if (v.includes("high") || v.includes("good")) return "#2e9e4f";
    if (v.includes("low")) return "#e14b3c";
    return "#f0a63c";
  };

  // Stress | Choice — the pill list stays exactly as drawn in the file (no
  // added ring/highlight on it); which band applies is already conveyed by
  // the big number + category text printed below, so nothing needs to be
  // drawn on top of the legend itself.
  const stressNum = data.stressScore || data.stressIndex;
  if (stressNum) {
    const v = /^\d+$/.test(stressNum) ? `${stressNum}.0` : stressNum;
    // Left edge is the caption's own (x=119.82, same as "brain activities"
    // below). That leaves ~200px before the template's band-legend pills start
    // (their boxes begin at x≈324), so cap the size at 96 and shrink from there
    // for longer values — "100.0" at 96 would run to x≈368, straight through
    // the pills.
    const emWidth = [...v].reduce((w, c) => w + (c === "." ? 0.28 : 0.576), 0);
    const fontSize = Math.min(96, 200 / emWidth);
    overlays.push(tspanBlock(CAPTION_X, 320, [v], 0, fontSize, "#4b3f9e", 800));
  }
  // L/R starts on the same left edge as the template's own "brain activities"
  // caption above it. Every gap here is an explicit dx rather than whitespace:
  // repeated spaces inside one text run collapse in SVG, so a padded "L: 987"
  // would render as "L:987" regardless. Letter, colon and number are each
  // their own tspan so both sides of the colon are set independently, and the
  // two are deliberately unequal: a small nudge before the colon so it isn't
  // jammed against the letter, and a wider one after it so the number still
  // reads as the value rather than part of the label. PAIR_GAP before "R"
  // keeps the two halves reading as separate values.
  if (data.lrBrain) {
    const PRE_COLON_GAP = 6; // between the letter and the colon
    const LABEL_GAP = 16; // after the colon, before the number
    const PAIR_GAP = 26; // between the L value and the R label
    const pair = (label: string, value: string, lead: string) =>
      `<tspan ${lead}>${label}</tspan>` +
      `<tspan dx="${PRE_COLON_GAP}">:</tspan>` +
      `<tspan dx="${LABEL_GAP}">${esc(value)}</tspan>`;
    overlays.push(
      `<text x="${CAPTION_X}" y="445" font-size="30" font-weight="700" fill="#4b3f9e" font-family="'Segoe UI', Arial, sans-serif">` +
        pair("L", data.lrBrain.left, `x="${CAPTION_X}"`) +
        pair("R", data.lrBrain.right, `dx="${PAIR_GAP}"`) +
        `</text>`,
    );
  }

  // Character & Real Intention / Communication & Learning Style
  // 843.15 is the chip box's own horizontal center (749.4 + 187.5/2) — text
  // needs "middle" anchor to actually sit on that center point instead of
  // starting there and growing rightward past it.
  if (data.presentCharacterName) overlays.push(tspanBlock(843.15, 262, [data.presentCharacterName], 0, 22, "#4b3f9e", 700, "middle"));
  if (data.realIntentionName) overlays.push(tspanBlock(843.15, 497, [data.realIntentionName], 0, 22, "#4b3f9e", 700, "middle"));
  data.baseAttrs.slice(0, 3).forEach((a, i) => overlays.push(tspanBlock(576, 355 + i * 30, [a], 0, 18, "#4b3f9e", 700)));
  data.nextAttrs.slice(0, 3).forEach((a, i) => overlays.push(tspanBlock(967, 355 + i * 30, [a], 0, 18, "#4b3f9e", 700)));

  // Emotional Pattern — the two cards the template draws are fixed boxes:
  // 503.9 x 120.5 each, top edge y=604, left at x=63 and right at x=626 (so
  // the x=76/x=639 text origins below are each the card's own left edge + 13
  // of padding). Nothing here can reflow, so the type scale is bounded by
  // that box, not by taste:
  //   - Vertically, 14 of top padding puts the title's baseline at 634, and
  //     the body starts at 653. PATTERN_MAX_BASELINE is the lowest a line can
  //     sit with its descenders still inside the card's bottom edge.
  //   - Horizontally the body wraps to a measured 478 — the card's own width
  //     less 13 of padding each side — so lines fill the box right up to the
  //     edge rather than stopping short of it, which character-count wrapping
  //     could not do safely. See wrapToWidth.
  // The title still wraps nowhere: it's one line by design, and a long label
  // will run past the card. Left as-is because every label in the data is
  // short; if that changes it needs the same measured treatment.
  const pattern = fitPatternPair(data.freqDesc, data.coreDesc);
  if (data.freqLabel) {
    overlays.push(tspanBlock(76, PATTERN_TITLE_BASELINE, [data.freqLabel], 0, PATTERN_TITLE_SIZE, "#4b3f9e", 700));
    overlays.push(tspanBlock(76, PATTERN_FIRST_BASELINE, pattern.freq, pattern.leading, pattern.fontSize, "#4b5563"));
  }
  if (data.coreLabel) {
    overlays.push(tspanBlock(639, PATTERN_TITLE_BASELINE, [data.coreLabel], 0, PATTERN_TITLE_SIZE, "#4b3f9e", 700));
    overlays.push(tspanBlock(639, PATTERN_FIRST_BASELINE, pattern.core, pattern.leading, pattern.fontSize, "#4b5563"));
  }

  // Behaviour Pattern — fill the client's own note on each track with a
  // solid diamond ringed in the report's orange, matching the template's own
  // unfilled diamonds' exact column positions so it reads as "this one" on
  // the grid already drawn, not a second grid.
  const idx1 = NOTE_SCALE.indexOf(data.note1);
  const idx2 = NOTE_SCALE.indexOf(data.note2);
  if (idx1 >= 0) overlays.push(markDiamond(noteColX(idx1), NOTE1_ROW_Y));
  if (idx2 >= 0) overlays.push(markDiamond(noteColX(idx2), NOTE2_ROW_Y));

  // Same note 1/2, drawn bigger in their own real color on the wheel — every
  // other note stays exactly as the template draws it.
  overlays.push(emphasizeSelectedWheelNotes([data.note1, data.note2].filter(Boolean)));

  // Lifepath Emotional Blueprint — the client's own 12-column line, on the
  // same column grid the template's checkboxes sit on.
  if (data.journeyValues.length === 12) {
    const pts = data.journeyValues.map((v, i) => `${bpColX(i)},${bpRowY(v)}`).join(" ");
    overlays.push(`<polyline points="${pts}" fill="none" stroke="#1f2937" stroke-width="1.8" />`);
    data.journeyValues.forEach((v, i) => {
      const cx = bpColX(i), cy = bpRowY(v), r = 7.5;
      overlays.push(
        `<path d="M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z" fill="#1f2937" stroke="#ffffff" stroke-width="1.6" />`,
      );
    });
  }
  // The checkbox row directly below the chart — measured centers x=70+54.05*i,
  // y=1331 top, h=28.9 — one age-bracket number per box.
  data.journeyAges.slice(0, 12).forEach((age, i) => {
    if (!age) return;
    overlays.push(
      `<text x="${bpColX(i)}" y="${1350.5}" font-size="12" font-weight="700" fill="#1f2328" font-family="'Segoe UI', Arial, sans-serif" text-anchor="middle">${esc(age)}</text>`,
    );
  });

  // top 5: empowering / dis-empowering — the template's blank area below the
  // blueprint chart, within the same panel, below the "top 5:" header labels
  // already printed in the background at this y.
  overlays.push(...renderTopFiveLists(data.constructive, data.restrictive));

  // Excellency — the client's own rating for each of the 7 rows, printed
  // clear of the row's own gray box (past its right edge at x=1005.1) in the
  // open margin beside it, not crowded against the label text inside the box.
  data.dynamics.slice(0, 7).forEach((d, i) => {
    const row = EXCELLENCY_ROWS[i];
    if (!row) return;
    overlays.push(
      `<text x="${row.x + row.w + 22}" y="${row.y + row.h / 2 + 8}" font-size="23" font-weight="700" fill="${ratingClass(
        d.rating,
      )}" font-family="'Segoe UI', Arial, sans-serif" text-anchor="start">${esc(d.rating)}</text>`,
    );
  });

  // Puppeteer's page.pdf({format:"A4"}) lays out CSS at 96px/inch (A4 =
  // ~794x1123 CSS px), then subtracts the 20px margin htmlToPdf applies on
  // each side — same "754px usable width" convention already established
  // elsewhere in this file. The template's viewBox (1190.25 x 1683.75) is
  // 1.5x that usable page (a 144dpi/150% export, not a 2x/point-based one —
  // confirmed by the ratio: 1190.25/754 ≈ 1683.75/1078). Rather than rescale
  // every coordinate pulled from the file, the whole 1190x1684 canvas is
  // drawn once at its native size and scaled down as a block onto that
  // printable area, so every extracted coordinate above stays exactly as
  // read off the file.
  const PAGE_W = 754;
  const PAGE_H = 1078;
  const scale = PAGE_W / 1190.25;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { background: #ffffff; margin: 0; }
  .frame { position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; }
  .canvas { position: absolute; top: 0; left: 0; width: 1190.25px; height: 1683.75px; transform: scale(${scale}); transform-origin: top left; }
</style>
</head>
<body>
  <div class="frame">
    <div class="canvas">
      ${svgBackground}
      <svg viewBox="0 0 1190.25 1683.749949" style="position:absolute;top:0;left:0;width:1190.25px;height:1683.75px" xmlns="http://www.w3.org/2000/svg">
        ${overlays.join("\n")}
      </svg>
    </div>
  </div>
</body>
</html>`;
}
