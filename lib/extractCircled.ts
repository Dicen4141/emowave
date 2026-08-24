import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export type CircledMark = { page: number; index: number; text: string };

function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...new Set(points.map((p) => `${p[0]},${p[1]}`))]
    .map((s) => s.split(",").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// Expand the hull outward a touch so words whose center sits right on a
// thin/loose stroke still count as circled.
function padHull(hull: [number, number][], pad = 3.0): [number, number][] {
  if (hull.length < 3) return hull;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    return [x + (dx / dist) * pad, y + (dy / dist) * pad] as [number, number];
  });
}

function pointInPolygon([x, y]: [number, number], poly: [number, number][]): boolean {
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

function inkStrokesToPoints(inkLists: number[][]): [number, number][] {
  const pts: [number, number][] = [];
  for (const stroke of inkLists) {
    for (let i = 0; i < stroke.length; i += 2) pts.push([stroke[i], stroke[i + 1]]);
  }
  return pts;
}

/**
 * Finds every hand-drawn circle (/Ink annotation) in a PDF and returns the
 * text whose word-center falls inside it, using the pen's real coordinates
 * (point-in-polygon) rather than OCR/vision guessing.
 */
export async function extractCircledText(pdfBytes: Buffer | Uint8Array): Promise<CircledMark[]> {
  // pdf.js explicitly rejects Node's Buffer (a Uint8Array subclass) — always
  // copy into a plain Uint8Array regardless of what was passed in.
  const data = new Uint8Array(pdfBytes);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const results: CircledMark[] = [];

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    const annots = await page.getAnnotations();
    const inkAnnots = annots.filter((a: any) => a.subtype === "Ink" && a.inkLists?.length);
    if (!inkAnnots.length) continue;

    const textContent = await page.getTextContent();
    const items = textContent.items
      .filter((it: any) => it.str && it.str.trim())
      .map((it: any) => {
        const [a, , , d, e, f] = it.transform;
        const w = it.width ?? Math.abs(a) * it.str.length;
        const h = it.height ?? (Math.abs(d) || 10);
        return { str: it.str as string, cx: e + w / 2, cy: f + h / 2 };
      });

    inkAnnots.forEach((annot: any, i: number) => {
      const points = inkStrokesToPoints(annot.inkLists);
      if (points.length < 3) return;
      const hull = padHull(convexHull(points), 3.0);

      const matched = items.filter((it: { cx: number; cy: number }) => pointInPolygon([it.cx, it.cy], hull));
      if (!matched.length) return;

      const text = matched
        .map((m: { str: string }) => m.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      results.push({ page: pno, index: i + 1, text });
    });
  }

  return results;
}
