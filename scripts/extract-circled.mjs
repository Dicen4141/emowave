// Extract text enclosed by hand-drawn circles (PDF /Ink annotations).
//
// Node.js port of extract_circled.py — same approach, same result:
//   - Reads the actual pen coordinates PDF.js exposes for each Ink
//     annotation (annot.inkLists) -- exact, not OCR/vision guesses.
//   - Builds a convex hull around each stroke's points to close the loop.
//   - Pulls every text run's bounding box on the page (page.getTextContent())
//     and keeps the ones whose center point falls inside the hull
//     (point-in-polygon, ray casting).
//
// Usage:
//   node extract-circled.mjs "<path-to-pdf>" [more paths...] [--out-dir <dir>]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function convexHull(points) {
  const pts = [...new Set(points.map(p => `${p[0]},${p[1]}`))]
    .map(s => s.split(',').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function padHull(hull, pad = 3.0) {
  if (hull.length < 3) return hull;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    return [x + (dx / dist) * pad, y + (dy / dist) * pad];
  });
}

function pointInPolygon([x, y], poly) {
  if (poly.length < 3) return false;
  let inside = false;
  let [x1, y1] = poly[poly.length - 1];
  for (const [x2, y2] of poly) {
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1 + 1e-12) + x1) {
      inside = !inside;
    }
    [x1, y1] = [x2, y2];
  }
  return inside;
}

function inkStrokesToPoints(inkLists) {
  // Each stroke is a flat number array [x0,y0,x1,y1,...]
  const pts = [];
  for (const stroke of inkLists) {
    for (let i = 0; i < stroke.length; i += 2) pts.push([stroke[i], stroke[i + 1]]);
  }
  return pts;
}

async function extractCircles(pdfPath) {
  const data = new Uint8Array(await readFile(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const results = [];

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    const annots = await page.getAnnotations();
    const inkAnnots = annots.filter(a => a.subtype === 'Ink' && a.inkLists?.length);
    if (!inkAnnots.length) continue;

    const textContent = await page.getTextContent();
    const items = textContent.items
      .filter(it => it.str && it.str.trim())
      .map(it => {
        const [a, , , d, e, f] = it.transform;
        const w = it.width ?? Math.abs(a) * it.str.length;
        const h = it.height ?? (Math.abs(d) || 10);
        return { str: it.str, cx: e + w / 2, cy: f + h / 2 };
      });

    inkAnnots.forEach((annot, i) => {
      const points = inkStrokesToPoints(annot.inkLists);
      if (points.length < 3) return;
      const hull = padHull(convexHull(points), 3.0);

      const matched = items.filter(it => pointInPolygon([it.cx, it.cy], hull));
      if (!matched.length) return;

      const text = matched.map(m => m.str).join(' ').replace(/\s+/g, ' ').trim();
      results.push({ page: pno, index: i + 1, text });
    });
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const outDirIdx = args.indexOf('--out-dir');
  let outDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  if (outDirIdx !== -1) {
    outDir = args[outDirIdx + 1];
    args.splice(outDirIdx, 2);
  }
  await mkdir(outDir, { recursive: true });

  if (!args.length) {
    console.error('Usage: node extract-circled.mjs <pdf...> [--out-dir <dir>]');
    process.exit(1);
  }

  for (const pdfArg of args) {
    const circles = await extractCircles(pdfArg);
    const base = path.basename(pdfArg, path.extname(pdfArg));
    const outPath = path.join(outDir, `${base} - circled_text.txt`);

    let out = `Circled text extracted from: ${path.basename(pdfArg)}\n`;
    out += `Total marks found: ${circles.length}\n`;
    out += '='.repeat(70) + '\n\n';
    for (const c of circles) {
      out += `[Page ${c.page}, mark ${c.index}]\n${c.text}\n\n`;
    }
    await writeFile(outPath, out, 'utf-8');
    console.log(`${path.basename(pdfArg)}: ${circles.length} circled mark(s) -> ${outPath}`);
  }
}

main();
