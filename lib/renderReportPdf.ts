import puppeteer from "puppeteer";
import type { Assessment, ReportFact } from "@prisma/client";

type AssessmentWithFacts = Assessment & { facts: ReportFact[] };

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A fact's value is jsonb: a plain string for prose fields, an object for
// structured ones (L/R Brain, Vortex Energy, Stress type). Render both.
function renderValue(value: unknown): string {
  if (typeof value === "string") {
    return `<p class="fact-value">${escapeHtml(value)}</p>`;
  }
  if (value && typeof value === "object") {
    const rows = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<tr><td class="k">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
      .join("");
    return `<table class="fact-table">${rows}</table>`;
  }
  return `<p class="fact-value">${escapeHtml(String(value))}</p>`;
}

// Groups facts by section, preserving first-seen order.
export function groupBySection(facts: ReportFact[]) {
  const groups = new Map<string, ReportFact[]>();
  for (const f of facts) {
    if (!groups.has(f.section)) groups.set(f.section, []);
    groups.get(f.section)!.push(f);
  }
  return groups;
}

// If a fact's value is the "L=715, R=725" pattern produced by the
// extractor for the L/R Brain field, render it as a real two-column
// Left/Right table (matching the reference design's "Brain Activities"
// table) instead of as a plain sentence.
function tryRenderLeftRight(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.match(/^L=(\d+),\s*R=(\d+)$/);
  if (!m) return null;
  return `
    <table class="lr-table">
      <thead><tr><th>Left</th><th>Right</th></tr></thead>
      <tbody><tr><td>${escapeHtml(m[1])}</td><td>${escapeHtml(m[2])}</td></tr></tbody>
    </table>`;
}

// Renders one <section> per fact group — shared by the generic report
// template below AND the dedicated iEmoWave-Full renderer (renderEwFullReport.ts),
// which uses this (unnumbered) to append any Aquera/Emotional-Notes-sourced
// facts that its own hand-built sections don't already cover, instead of
// silently dropping them.
export function renderFactGroupsHtml(
  groups: Map<string, ReportFact[]>,
  opts: { numbered?: boolean; unlockedSections?: Set<string> } = {},
): string {
  const isUnlocked = (section: string) => !opts.unlockedSections || opts.unlockedSections.has(section);
  let sectionNumber = 0;
  return [...groups.entries()]
    .map(([section, facts]) => {
      sectionNumber++;
      const heading = opts.numbered ? `${sectionNumber}. ${escapeHtml(section)}` : escapeHtml(section);
      if (!isUnlocked(section)) {
        return `
          <section class="section locked">
            <h2>${heading}</h2>
            <div class="lock-teaser">
              <p>🔒 Unlock the full report to see this section.</p>
            </div>
          </section>`;
      }

      // Exactly two facts read better as two boxes side by side (mirroring
      // the reference design's BASE/NEXT layout) only when both are
      // substantial and roughly balanced in length — pairing a one-line
      // note with a 500-character paragraph (e.g. "Public Self - note" +
      // "- full") produced a box that was 90% empty space, so short/
      // mismatched pairs fall back to the normal stacked layout instead.
      const valueLength = (v: unknown) => (typeof v === "string" ? v.length : JSON.stringify(v ?? "").length);
      const lengths = facts.map((f) => valueLength(f.value));
      const pairable =
        facts.length === 2 &&
        lengths.every((len) => len > 150) &&
        Math.min(...lengths) / Math.max(...lengths) > 0.4;
      const factsHtml = pairable
        ? `<div class="pair">
            ${facts
              .map(
                (f) =>
                  `<div class="pair-box"><div class="pair-label">${escapeHtml(f.label)}</div>${
                    tryRenderLeftRight(f.value) ?? renderValue(f.value)
                  }</div>`,
              )
              .join("")}
          </div>`
        : facts
            .map(
              (f) =>
                `<div class="fact"><h3>${escapeHtml(f.label)}</h3>${
                  tryRenderLeftRight(f.value) ?? renderValue(f.value)
                }</div>`,
            )
            .join("");

      return `<section class="section"><h2>${heading}</h2>${factsHtml}</section>`;
    })
    .join("");
}

/**
 * Builds the report as an HTML string. Same template for preview and full —
 * `unlockedSections` controls which sections render in full vs. as a
 * blurred/locked teaser, so the paywall gate happens server-side (the
 * client never receives the locked HTML/text at all).
 *
 * Visual language (numbered orange headings, boxed base/next pairs,
 * disclaimer footer) is adapted from a reference "iEmoWave" sample report
 * the client shared — same styling conventions, but only applied to
 * sections we actually have data for. That reference also has charts we
 * have no underlying data for (a stress-score gauge, seven leadership-
 * dynamics bars, a life-journey graph) — those are NOT reproduced here;
 * inventing numbers for them would be fabricating client data.
 */
export function renderReportHtml(assessment: AssessmentWithFacts, unlockedSections?: Set<string>): string {
  const groups = groupBySection(assessment.facts);
  const sectionsHtml = renderFactGroupsHtml(groups, { numbered: true, unlockedSections });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<style>
  * { box-sizing: border-box; }
  /* This is a formatted document (like a PDF) — it should always render the
     same regardless of the viewer's OS/browser dark-mode preference, not get
     auto-inverted into an unreadable dark page. */
  html, body { background: #ffffff; }
  body {
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1f2328;
    margin: 0;
    padding: 40px 56px;
  }

  .head-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 2px solid #f16421;
    padding-bottom: 14px;
    margin-bottom: 28px;
  }
  .head-meta p { margin: 0 0 4px; font-size: 13px; }
  .head-meta .k { color: #6b7280; margin-right: 6px; }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .logo .emo { color: #1f2328; }
  .logo .waves { color: #f16421; }
  .logo-tag { font-size: 10px; color: #9ca3af; font-style: italic; text-align: right; margin-top: 2px; }

  .section { margin-bottom: 26px; page-break-inside: avoid; }
  .section h2 {
    font-size: 15px;
    font-weight: 700;
    color: #f16421;
    border-bottom: 1px solid #f4c9ae;
    padding-bottom: 6px;
    margin: 0 0 12px;
  }

  .fact { margin-bottom: 14px; }
  .fact h3 { font-size: 13px; margin: 0 0 4px; color: #374151; }
  .fact-value { font-size: 13px; line-height: 1.6; margin: 0; white-space: pre-line; }
  .fact-table { border-collapse: collapse; font-size: 13px; }
  .fact-table td { padding: 2px 10px 2px 0; }
  .fact-table td.k { color: #6b7280; }

  .pair { display: flex; gap: 14px; }
  .pair-box { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; }
  .pair-label { font-size: 11.5px; font-weight: 700; color: #f16421; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 6px; }
  .pair-box .fact-value { font-size: 12.5px; }

  .lr-table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  .lr-table th, .lr-table td { border: 1px solid #e5e7eb; padding: 6px 12px; text-align: center; }
  .lr-table th { background: #efefef; font-size: 12px; color: #374151; }
  .lr-table td { font-size: 15px; font-weight: 600; }

  .section.locked { background: #f9fafb; border-radius: 8px; padding: 16px; }
  .lock-teaser { color: #9ca3af; font-size: 13px; text-align: center; padding: 20px 0; }

  .disclaimer {
    margin-top: 32px;
    background: #f2f2f2;
    border-radius: 6px;
    padding: 12px 16px;
    font-size: 10px;
    line-height: 1.5;
    color: #4b5563;
  }
</style>
</head>
<body>
  <div class="head-row">
    <div class="head-meta">
      <p><span class="k">Name:</span>${escapeHtml(assessment.customerId)}</p>
      <p><span class="k">Date:</span>${assessment.createdAt.toISOString().slice(0, 10)}</p>
    </div>
    <div>
      <div class="logo"><span class="emo">Emo</span><span class="waves">Waves</span></div>
      <div class="logo-tag">Your journey, understood</div>
    </div>
  </div>

  ${sectionsHtml}

  <div class="disclaimer">
    This report is generated from your voice-analysis data for self-reflection and personal-growth purposes.
    It is not medical, psychological, financial, or legal advice, and should not be treated as a diagnosis or
    professional recommendation. If you have concerns about your health or wellbeing, please consult an
    appropriately qualified professional.
  </div>
</body>
</html>`;
}

// Single mark identifying the one "speaker" — used once at the top, the way
// Claude's UI shows one avatar per turn, not one per paragraph.
const AVATAR = "🌊";

/**
 * The live user-facing page (/report/[id]) — same facts as the PDF, but
 * typeset like a single long Claude response instead of a printed document,
 * since this is read on screen, not printed. The PDF keeps its own
 * document-style template (renderReportHtml above) on purpose — different
 * medium, so a different layout, even though the underlying data is
 * identical.
 *
 * Deliberately NOT a bubble-chat UI: real chat products (Claude included)
 * mostly don't box assistant text in colored bubbles — text sits on the
 * page with generous spacing, one avatar per turn, and structure comes from
 * headers/weight, not containers. There's also no input box here — this is
 * one-way delivery, not a live conversation, so nothing here should imply
 * you can type back.
 */
export function renderReportChatHtml(assessment: AssessmentWithFacts): string {
  const groups = groupBySection(assessment.facts);

  const bodyHtml = [...groups.entries()]
    .map(
      ([section, facts]) => `
        <h2>${escapeHtml(section)}</h2>
        ${facts
          .map(
            (f) => `
          <div class="point">
            <p class="point-label">${escapeHtml(f.label)}</p>
            ${renderValue(f.value)}
          </div>`,
          )
          .join("")}`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #faf9f5; --text: #2a2721; --muted: #75706a; --border: #e7e3da; --accent: #ca6c46;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #262624; --text: #f2efe9; --muted: #a19c93; --border: #3a3733; --accent: #e08662; }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    font-family: -apple-system, "Segoe UI", system-ui, Roboto, sans-serif;
    color: var(--text);
    margin: 0;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 680px; margin: 0 auto; padding: 48px 24px 100px; }

  .turn-head { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .avatar {
    flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%;
    background: var(--accent);
    display: flex; align-items: center; justify-content: center; font-size: 14px;
  }
  .turn-head .meta { font-size: 13px; color: var(--muted); }
  .turn-head .meta strong { color: var(--text); font-weight: 600; }

  h2 {
    font-size: 15px; font-weight: 600;
    color: var(--accent);
    margin: 36px 0 14px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  h2:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }

  .point { margin-bottom: 18px; }
  .point:last-child { margin-bottom: 0; }
  .point-label { font-size: 14.5px; font-weight: 600; margin: 0 0 3px; color: var(--text); }
  .fact-value { font-size: 15.5px; line-height: 1.7; margin: 0; white-space: pre-line; color: var(--text); }
  .fact-table { border-collapse: collapse; font-size: 14px; }
  .fact-table td { padding: 2px 12px 2px 0; }
  .fact-table td.k { color: var(--muted); }

  @media (prefers-reduced-motion: no-preference) {
    .point, h2 { animation: rise 0.4s ease backwards; }
  }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="turn-head">
      <div class="avatar">${AVATAR}</div>
      <p class="meta"><strong>${escapeHtml(assessment.customerId)}</strong> · Assessment #${assessment.id.toString()}</p>
    </div>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

/**
 * Running header/footer drawn on every page, supplied by the report that wants
 * them. Chrome renders these templates into the page's margin boxes and clips
 * them to it, so a report that provides chrome also provides the deeper
 * top/bottom margins the templates need to fit.
 */
export type PdfChrome = {
  headerTemplate: string;
  footerTemplate: string;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
};

// Uint8Array rather than Buffer: it is what page.pdf() already returns, it is
// a valid BodyInit so a route can hand it straight back, and Supabase storage
// takes it as-is. Buffer.from() only copied the whole PDF to gain nothing, and
// a Buffer is not assignable to BodyInit under current @types/node anyway.
//
// The <ArrayBuffer> parameter is load-bearing, not decoration: the DOM lib
// defines BufferSource as ArrayBufferView<ArrayBuffer>, so the bare
// Uint8Array<ArrayBufferLike> Puppeteer declares — which admits a
// SharedArrayBuffer backing — is rejected as a response body. Chrome's PDF
// bytes are never shared-backed, so the narrowing at the return is sound.
export async function htmlToPdf(html: string, chrome?: PdfChrome): Promise<Uint8Array<ArrayBuffer>> {
  // --no-sandbox because the container runs as root (the image declares no
  // USER), and Chrome refuses to start as root with its sandbox enabled:
  // "Running as root without --no-sandbox is not supported". That failure is
  // runtime-only — the image builds and the app boots fine, every report just
  // 500s. --disable-dev-shm-usage because App Platform gives the container a
  // 64 MB /dev/shm, which a full-page render outgrows and Chrome then crashes
  // mid-print rather than reporting anything useful.
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    // "load", not "networkidle0" — Puppeteer's own types stopped accepting the
    // latter for setContent, and it would buy nothing anyway: a report embeds
    // every font and image as a data URI, so there are no network requests for
    // an idle window to wait on. "load" already covers those inline resources.
    await page.setContent(html, { waitUntil: "load" });
    // Wait for webfonts before snapshotting. Reports embed their faces as
    // base64 data URIs, which are not network requests, so page load is
    // already satisfied while those faces may still be decoding. Chrome has
    // been reliable about it here, but the failure mode is silent and ugly if
    // it ever isn't: the PDF renders in a fallback face whose metrics move
    // every line break, and therefore every page break, in the document.
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px", ...chrome?.margin },
      ...(chrome && {
        displayHeaderFooter: true,
        headerTemplate: chrome.headerTemplate,
        footerTemplate: chrome.footerTemplate,
      }),
    });
    return pdf as Uint8Array<ArrayBuffer>;
  } finally {
    await browser.close();
  }
}
