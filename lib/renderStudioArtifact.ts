import type { StudioKind, SlideDeck, Flashcards, Quiz, Infographic, DataTable } from "./studioArtifacts";
import { studioLabel } from "./studioArtifacts";

// Standalone pages (they're iframed into the Studio modal), so they carry
// their own copy of the palette rather than importing globals.css — same
// values as app/globals.css :root, kept in sync by hand. Deliberately no
// nav/chrome: the modal around them already provides that.
const SHELL_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px; background: #0d111b; color: #e8ecf5;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.55; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #96a2b8; font-size: 13px; margin: 0 0 18px; }
  .card { background: #171e2d; border: 1px solid #28324a; border-radius: 11px; padding: 14px 16px; margin-bottom: 12px; }
  .k { color: #96a2b8; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .err { border-color: #f4707c; color: #f4707c; }
  .muted { color: #96a2b8; }
`;

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, css: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${SHELL_CSS}${css}</style></head>
<body>${body}</body></html>`;
}

/** Shown in the same frame as a real artifact, so a failure is visible rather than a blank panel. */
export function renderStudioError(kind: StudioKind, message: string): string {
  return page(
    studioLabel(kind),
    "",
    `<h1>${esc(studioLabel(kind))}</h1>
     <div class="card err"><div class="k">Not generated</div>${esc(message)}</div>`,
  );
}

function renderSlideDeck(d: SlideDeck): string {
  const css = `
    .slide { background: #171e2d; border: 1px solid #28324a; border-radius: 11px; padding: 16px 18px; margin-bottom: 12px; }
    .slide-no { color: #5b9dfb; font-size: 11px; font-weight: 700; letter-spacing: .08em; }
    .slide h2 { font-size: 16px; margin: 2px 0 10px; }
    .slide ul { margin: 0; padding-left: 18px; }
    .slide li { margin-bottom: 5px; }
    .notes { margin-top: 10px; padding-top: 9px; border-top: 1px solid #28324a; color: #96a2b8; font-size: 12.5px; font-style: italic; }`;
  const slides = (d.slides ?? [])
    .map(
      (s, i) => `<div class="slide">
        <div class="slide-no">SLIDE ${i + 1}</div>
        <h2>${esc(s.title)}</h2>
        <ul>${(s.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
        ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ""}
      </div>`,
    )
    .join("");
  return page(d.title, css, `<h1>${esc(d.title)}</h1><p class="sub">${esc(d.subtitle)}</p>${slides}`);
}

function renderFlashcards(d: Flashcards): string {
  // Click-to-flip with no framework: the back is hidden until the card gets
  // the .open class, and one delegated listener covers every card.
  const css = `
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .fc { background: #171e2d; border: 1px solid #28324a; border-radius: 11px; padding: 14px 15px; cursor: pointer;
          min-height: 118px; display: flex; flex-direction: column; justify-content: center; transition: border-color .16s; }
    .fc:hover { border-color: #3a4764; }
    .fc.open { border-color: #5b9dfb; background: #1e2739; }
    .front { font-weight: 600; }
    .back { display: none; margin-top: 9px; padding-top: 9px; border-top: 1px solid #28324a; color: #96a2b8; }
    .fc.open .back { display: block; }
    .hint { color: #6b7891; font-size: 11px; margin-top: 8px; }
    .fc.open .hint { display: none; }`;
  const cards = (d.cards ?? [])
    .map(
      (c) => `<div class="fc">
        <div class="front">${esc(c.front)}</div>
        <div class="back">${esc(c.back)}</div>
        <div class="hint">click to reveal</div>
      </div>`,
    )
    .join("");
  const js = `document.addEventListener("click", function (e) {
      var card = e.target.closest(".fc");
      if (card) card.classList.toggle("open");
    });`;
  return page(
    d.title,
    css,
    `<h1>${esc(d.title)}</h1><p class="sub">${(d.cards ?? []).length} cards — click one to reveal the answer.</p>
     <div class="grid">${cards}</div><script>${js}</script>`,
  );
}

function renderQuiz(d: Quiz): string {
  const css = `
    .q { background: #171e2d; border: 1px solid #28324a; border-radius: 11px; padding: 14px 16px; margin-bottom: 12px; }
    .q h2 { font-size: 15px; margin: 0 0 10px; }
    .opt { display: block; width: 100%; text-align: left; background: #1e2739; color: #e8ecf5; border: 1px solid #28324a;
           border-radius: 7px; padding: 9px 11px; margin-bottom: 7px; cursor: pointer; font: inherit; }
    .opt:hover { border-color: #3a4764; }
    .opt.right { border-color: #4ecf9a; background: #4ecf9a1a; }
    .opt.wrong { border-color: #f4707c; background: #f4707c1a; }
    .exp { display: none; margin-top: 8px; padding-top: 9px; border-top: 1px solid #28324a; color: #96a2b8; font-size: 13px; }
    .q.done .exp { display: block; }`;
  const questions = (d.questions ?? [])
    .map(
      (q, i) => `<div class="q" data-answer="${Number(q.answerIndex) || 0}">
        <h2>${i + 1}. ${esc(q.question)}</h2>
        ${(q.options ?? []).map((o, oi) => `<button class="opt" data-i="${oi}">${esc(o)}</button>`).join("")}
        <div class="exp">${esc(q.explanation)}</div>
      </div>`,
    )
    .join("");
  // Marks the picked option and always reveals the correct one, then locks
  // that question so a second click can't rewrite the first answer.
  const js = `document.addEventListener("click", function (e) {
      var opt = e.target.closest(".opt");
      if (!opt) return;
      var q = opt.closest(".q");
      if (q.classList.contains("done")) return;
      var answer = Number(q.dataset.answer);
      q.querySelectorAll(".opt").forEach(function (b) {
        if (Number(b.dataset.i) === answer) b.classList.add("right");
        else if (b === opt) b.classList.add("wrong");
      });
      q.classList.add("done");
    });`;
  return page(
    d.title,
    css,
    `<h1>${esc(d.title)}</h1><p class="sub">${(d.questions ?? []).length} questions — pick an answer to see if it's right.</p>
     ${questions}<script>${js}</script>`,
  );
}

function renderInfographic(d: Infographic): string {
  const css = `
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .stat { background: #171e2d; border: 1px solid #28324a; border-radius: 11px; padding: 16px; text-align: center; }
    .stat .v { font-size: 26px; font-weight: 700; color: #5b9dfb; line-height: 1.15; }
    .stat .l { color: #96a2b8; font-size: 12px; margin-top: 5px; }
    .sec h2 { font-size: 14px; margin: 0 0 5px; color: #5b9dfb; }
    .sec p { margin: 0; color: #cdd5e4; }`;
  const stats = (d.stats ?? [])
    .map((s) => `<div class="stat"><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`)
    .join("");
  const sections = (d.sections ?? [])
    .map((s) => `<div class="card sec"><h2>${esc(s.heading)}</h2><p>${esc(s.text)}</p></div>`)
    .join("");
  return page(
    d.title,
    css,
    `<h1>${esc(d.title)}</h1><p class="sub">${esc(d.subtitle)}</p><div class="stats">${stats}</div>${sections}`,
  );
}

function renderDataTable(d: DataTable): string {
  const css = `
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: #96a2b8; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
         padding: 8px 10px; border-bottom: 1px solid #28324a; }
    td { padding: 9px 10px; border-bottom: 1px solid #28324a; vertical-align: top; }
    tr:last-child td { border-bottom: 0; }
    .sec-cell { color: #5b9dfb; white-space: nowrap; }
    .field-cell { color: #96a2b8; }`;
  const rows = (d.rows ?? [])
    .map(
      (r) => `<tr><td class="sec-cell">${esc(r.section)}</td><td class="field-cell">${esc(r.field)}</td><td>${esc(r.value)}</td></tr>`,
    )
    .join("");
  return page(
    d.title,
    css,
    `<h1>${esc(d.title)}</h1><p class="sub">${(d.rows ?? []).length} data points.</p>
     <div class="card" style="padding: 4px 6px"><table>
       <thead><tr><th>Section</th><th>Field</th><th>Value</th></tr></thead>
       <tbody>${rows}</tbody>
     </table></div>`,
  );
}

export function renderStudioArtifactHtml(kind: StudioKind, data: any): string {
  switch (kind) {
    case "slide-deck":
      return renderSlideDeck(data as SlideDeck);
    case "flashcards":
      return renderFlashcards(data as Flashcards);
    case "quiz":
      return renderQuiz(data as Quiz);
    case "infographic":
      return renderInfographic(data as Infographic);
    case "data-table":
      return renderDataTable(data as DataTable);
  }
}
