"""
Extract text enclosed by hand-drawn circles (PDF /Ink annotations).

Usage:
    python extract_circled.py "<path-to-pdf>" [more paths...]

For each PDF, writes "<pdf-name> - circled_text.txt" next to this script
(or to --out-dir if given), listing the text found inside every ink stroke
on every page, in reading order.

How it works:
    - Reads the actual pen coordinates PyMuPDF exposes for each /Ink annot
      (annot.vertices) -- these are exact, not OCR/vision guesses.
    - Builds a convex hull around each stroke's points to close the loop
      (a hand-drawn circle rarely closes itself exactly).
    - Pulls every word's bounding box on the page (page.get_text("words"))
      and keeps the ones whose center point falls inside the hull
      (point-in-polygon, ray casting).
    - Words are re-joined in (block, line, word) order so the circled
      phrase reads naturally even if the circle is not a perfect oval.
"""

import sys
import argparse
from pathlib import Path

import fitz  # PyMuPDF


def convex_hull(points):
    """Andrew's monotone chain. points: list of (x, y). Returns hull in CCW order."""
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def point_in_polygon(pt, poly):
    """Ray-casting point-in-polygon test. poly: list of (x, y)."""
    x, y = pt
    inside = False
    n = len(poly)
    if n < 3:
        return False
    x1, y1 = poly[-1]
    for x2, y2 in poly:
        if ((y1 > y) != (y2 > y)) and (
            x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1
        ):
            inside = not inside
        x1, y1 = x2, y2
    return inside


def pad_hull(hull, pad=3.0):
    """Expand hull outward slightly so words whose center sits right on the
    stroke (common with thin/loose circles) still count as inside."""
    if len(hull) < 3:
        return hull
    cx = sum(p[0] for p in hull) / len(hull)
    cy = sum(p[1] for p in hull) / len(hull)
    out = []
    for x, y in hull:
        dx, dy = x - cx, y - cy
        dist = (dx ** 2 + dy ** 2) ** 0.5 or 1.0
        out.append((x + dx / dist * pad, y + dy / dist * pad))
    return out


def extract_circles(pdf_path: Path):
    """Returns a list of dicts: {page, index, bbox, text}."""
    doc = fitz.open(pdf_path)
    results = []

    for pno in range(len(doc)):
        page = doc[pno]
        annots = page.annots()
        if not annots:
            continue

        ink_annots = [a for a in annots if a.type[1] == "Ink"]
        if not ink_annots:
            continue

        words = page.get_text("words")  # x0,y0,x1,y1,word,block,line,word_no

        for i, annot in enumerate(ink_annots, start=1):
            all_points = [pt for stroke in annot.vertices for pt in stroke]
            if len(all_points) < 3:
                continue

            hull = convex_hull(all_points)
            hull = pad_hull(hull, pad=3.0)

            matched = []
            for x0, y0, x1, y1, word, block_no, line_no, word_no in words:
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                if point_in_polygon((cx, cy), hull):
                    matched.append((block_no, line_no, word_no, word))

            if not matched:
                continue

            matched.sort(key=lambda t: (t[0], t[1], t[2]))
            text = " ".join(w for *_key, w in matched)

            xs = [p[0] for p in all_points]
            ys = [p[1] for p in all_points]
            bbox = (min(xs), min(ys), max(xs), max(ys))

            results.append(
                {"page": pno + 1, "index": i, "bbox": bbox, "text": text}
            )

    doc.close()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdfs", nargs="+", help="PDF file(s) to process")
    parser.add_argument("--out-dir", default=None, help="Where to write output .txt files")
    args = parser.parse_args()

    out_dir = Path(args.out_dir) if args.out_dir else Path(__file__).parent

    for pdf_arg in args.pdfs:
        pdf_path = Path(pdf_arg)
        if not pdf_path.exists():
            print(f"SKIP (not found): {pdf_path}")
            continue

        circles = extract_circles(pdf_path)
        out_path = out_dir / f"{pdf_path.stem} - circled_text.txt"

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(f"Circled text extracted from: {pdf_path.name}\n")
            f.write(f"Total marks found: {len(circles)}\n")
            f.write("=" * 70 + "\n\n")
            for c in circles:
                f.write(f"[Page {c['page']}, mark {c['index']}]\n")
                f.write(f"{c['text']}\n\n")

        print(f"{pdf_path.name}: {len(circles)} circled mark(s) -> {out_path}")


if __name__ == "__main__":
    main()
