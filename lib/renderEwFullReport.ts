import type {
  Assessment,
  ReportFact,
  StressContent,
  EmotionalStateContent,
  SensoryAttributesContent,
  PresentCharacterContent,
  TopAttributeContent,
  WellnessChallengeContent,
  JourneyOverviewContent,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { renderOverviewSvgHtml, renderBehaviourPatternFragment } from "./renderOverviewSvg";
import { lookupQuantemoAge, ageBracketLabels, ageFromDateOfBirth } from "./quantemo";

export type AssessmentWithFacts = Assessment & {
  facts: ReportFact[];
  stressContent: StressContent | null;
  emotionalStateContent: EmotionalStateContent | null;
  sensoryAttributesContent: SensoryAttributesContent | null;
  presentCharacterContent: PresentCharacterContent | null;
  topAttributeContent: TopAttributeContent[];
  wellnessChallengeContent: WellnessChallengeContent[];
  journeyOverviewContent: JourneyOverviewContent | null;
};

export function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fact(facts: ReportFact[], label: string): string {
  const f = facts.find((x) => x.label === label);
  return f && typeof f.value === "string" ? f.value : "";
}

function factOrNull(facts: ReportFact[], label: string): string | null {
  const f = facts.find((x) => x.label === label);
  return f && typeof f.value === "string" ? f.value : null;
}

// Some of the vendor's own trait items are phrased as open questions
// ("Reading problems?", "Variable behaviour. Moodswings?") — in a finished
// client report that reads as the report second-guessing itself, so a
// trailing "?" becomes a full stop. Display-only: ReportFact and
// TopAttributeContent keep the vendor's exact wording, so the admin side
// (Manage Facts) still shows the original.
function asStatement(text: string): string {
  return text.replace(/\s*\?\s*$/, ".");
}

// Frequent/Core Emotion facts are stored combined as "q1: Quiet." — split
// back apart to render the code and label in their own boxes (matching the
// reference report's layout) without re-extracting.
/**
 * The "Report No." on a report is this client's ROUND number — their first
 * report is 1, their next is 2 — not the assessment's global id, which counts
 * every client's rounds together and would show a client "report no 214".
 * Counting by id rather than createdAt: id is autoincrement, so it is already
 * in creation order, and unlike a timestamp it can't tie. A round not yet
 * linked to a client (clientId null) stands alone, so it is that client's
 * first and only report.
 */
export async function clientRoundNo(assessment: { id: bigint; clientId: bigint | null }): Promise<number> {
  if (!assessment.clientId) return 1;
  return prisma.assessment.count({
    where: { clientId: assessment.clientId, id: { lte: assessment.id } },
  });
}

export function splitCodeLabel(combined: string): { code: string; label: string } {
  const m = /^(\S+):\s*(.*)$/.exec(combined);
  return m ? { code: m[1], label: m[2] } : { code: "", label: combined };
}

// The report's 12-note scale (NOTE_SCALE), the emotion wheel and the
// note_behavior_reference table are ALL keyed by sharps only — there is no
// "Db" slot anywhere — so a flat spelling has to resolve to the same pitch's
// sharp name or it matches nothing at all and the note silently goes unmarked.
// Client's own convention, NOT standard Western enharmonics: a flat is filed
// under the SAME LETTER's sharp — Db under D#, Gb under G#, Ab under A# —
// where music theory would instead call Db a C# and Gb an F#. Following the
// theory here would put a client's note on the wrong slot of the scale.
const FLAT_TO_SHARP: Record<string, string> = {
  Cb: "C#",
  Db: "D#",
  Fb: "F#",
  Gb: "G#",
  Ab: "A#",
  // E and B have no sharp slot on the 12-note scale, and E always resolves to
  // a single type no matter what follows it, so these keep the bare letter.
  Eb: "E",
  Bb: "B",
};
const SHARP_OVERFLOW: Record<string, string> = { "E#": "E", "B#": "B" };

/**
 * Reads a note out of the vendor's own spellings and returns it as one of the
 * 12 NOTE_SCALE names. Handles every form seen in the extracted data:
 * "C", "C-Major (C)", "C-Minor (Cm)", "A-minor (Am)", "E-Major (E)" and
 * "D flat -Major (Db)". Major/Minor never changes the note. Flats — written
 * either as "b" or the word "flat" — map to their sharp equivalent.
 */
export function normalizeNote(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";

  let letter = "";
  let accidental = "";
  // Prefer the vendor's own parenthesised short code ("… (Db)", "… (Cm)"),
  // which is unambiguous; the trailing m is Minor, not part of the note.
  const paren = /\(\s*([A-Ga-g])\s*(#|b|B)?\s*m?\s*\)/.exec(text);
  if (paren) {
    letter = paren[1].toUpperCase();
    accidental = paren[2] ? (paren[2] === "#" ? "#" : "b") : "";
  } else {
    // Otherwise the long spelling, anchored to the start so stray A-G letters
    // later in a sentence can't be mistaken for the note. The optional
    // Major/Minor suffix is consumed and the lookahead requires the note to
    // end there, so ordinary prose beginning with A-G ("Deep-rooted…") is
    // rejected rather than read as a note. `b` only counts as an accidental
    // when no letter follows it, so "Bb" is B-flat but "B but…" is just B.
    const long = /^\s*([A-Ga-g])\s*(#|sharp|flat|b(?![a-z]))?\s*(?:minor|major|maj|min|m)?(?=$|[\s\-–—(,.])/i.exec(text);
    if (!long) return "";
    letter = long[1].toUpperCase();
    const a = (long[2] ?? "").toLowerCase();
    accidental = a === "#" || a === "sharp" ? "#" : a === "b" || a === "flat" ? "b" : "";
  }

  const note = letter + accidental;
  return FLAT_TO_SHARP[note] ?? SHARP_OVERFLOW[note] ?? note;
}

// Leadership Dynamic ratings are stored as "Root Energy [C,C#] — Low (12)"
// (kept detailed for the record/editing) but the report itself should show
// just the plain rating word, matching the reference layout.
function simplifyRating(rating: string): string {
  const m = /—\s*(\S+)\s*\(/.exec(rating);
  return m ? m[1] : rating;
}

// Row 1-3 = constructive/green, 4-5 = accumulated/orange, 6-7 = restrictive/red
// — matches the reference report's own color key exactly.
function levelColor(level: number): string {
  if (level <= 3) return "#2e9e4f";
  if (level <= 5) return "#f0a63c";
  return "#e14b3c";
}

// Fixed band definitions from the client's reference report (not per-client
// data) — which band is "active" is decided from this client's own Stress
// Level score.
export const STRESS_BANDS = [
  { label: "Logical Stress", range: "0 – 5%", max: 5, color: "#4a9fe0" },
  { label: "Stable", range: "6 – 11%", max: 11, color: "#7b5ea7" },
  { label: "Accumulated (emotions)", range: "12 – 20%", max: 20, color: "#c23b7a" },
  { label: "Emotional Stress", range: "20 – 54%", max: 54, color: "#e0653c" },
  { label: "Extreme", range: ">54%", max: Infinity, color: "#d92b2b" },
];

function gaugeRingSvg(color: string, fillFraction: number): string {
  const r = 24, cx = 30, cy = 30, stroke = 7;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * Math.min(Math.max(fillFraction, 0), 1);
  return `<svg width="60" height="60" viewBox="0 0 60 60">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}" />
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})" />
  </svg>`;
}

// Fixed 12-note chromatic scale, used to place a client's Note 1/2 on the
// real reference chart (renderBehaviourPatternFragment) and to label the
// Journey Overview chart's columns in the Note Balance fallback case.
export const NOTE_SCALE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Mind Report's own stress-index scale — a different band system than
// iEmoWave-Full's (6 bands here, integer index instead of a 0-100 score),
// read off that report's own legend (page 2). Used only when a client has
// no iEmoWave-Full upload, so their Stress Level section still gets a real
// gauge instead of falling back to text-only.
export const MIND_STRESS_BANDS = [
  { label: "Low Stress", range: "0 – 1", max: 1, color: "#4a9fe0" },
  { label: "Logical Stress", range: "2 – 5", max: 5, color: "#7b5ea7" },
  { label: "Cumulative Stress", range: "6 – 15", max: 15, color: "#c23b7a" },
  { label: "Emotional Stress", range: "16 – 24", max: 24, color: "#e0653c" },
  { label: "High Stress", range: "25 – 40", max: 40, color: "#d9432b" },
  { label: "Very High Stress", range: ">40", max: Infinity, color: "#d92b2b" },
];

function gaugesHtml(bands: { label: string; range: string; max: number; color: string }[], scoreNum: number): string {
  const activeIndex = Number.isFinite(scoreNum) ? bands.findIndex((b) => scoreNum <= b.max) : -1;
  return `<div class="stress-gauges">
    ${bands
      .map(
        (b, i) => `
      <div class="gauge-item${i === activeIndex ? " active" : ""}">
        <div class="gauge-label">${escapeHtml(b.label)}</div>
        ${gaugeRingSvg(b.color, (i + 1) / bands.length)}
        <div class="gauge-range">${escapeHtml(b.range)}</div>
      </div>`,
      )
      .join("")}
  </div>`;
}

function stressGaugesHtml(scoreText: string): string {
  return gaugesHtml(STRESS_BANDS, parseFloat(scoreText));
}

function mindStressGaugesHtml(indexText: string): string {
  return gaugesHtml(MIND_STRESS_BANDS, parseFloat(indexText));
}

/**
 * Fallback for "Your Journey Overview" when there's no iEmoWave-Full upload
 * (so no Code/Value table with its own 1-7 levels) — rescales the Emotional
 * Notes report's "Note Balance" values (Gemini Vision-read off that chart's
 * image, readNoteBalanceChart) onto the same 1-7 scale via min-max
 * normalization, so it can drive the identical ring-grid chart below. Note
 * Balance has no per-client age data, so this mode labels columns by note
 * (C, C#, ... B) instead of age and omits the age-timeline framing
 * (NOW/0 endpoints, Present/Childhood divider) that would otherwise imply
 * ages we don't have.
 */
function noteBalanceToLevels(values: number[]): number[] {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return values.map((v) => Math.round(1 + (6 * (v - min)) / range));
}

/**
 * Fallback Character label for Section 5 when there's no iEmoWave-Full
 * upload — reformats the Mind Report's "Sensory personality mode
 * (Base/Next)" field ("The Mediator (9)") into the same "9 - Mediator"
 * style as iEmoWave-Full's own Character column. This is the vendor's own
 * short label, not AI content, so it's read straight from ReportFact — the
 * matching Trait/Summary (which ARE AI content, either paraphrased or
 * Gemini-generated) live in PresentCharacterContent instead, keyed by the
 * same Base/Next pairing.
 */
export function sensoryFallbackCharacter(facts: ReportFact[], key: "Base" | "Next"): string {
  const mode = fact(facts, `Sensory personality mode (${key})`);
  const m = /The\s+([A-Za-z][A-Za-z\s]*?)\s*\((\d+(?:\.\d+)?)\)/.exec(mode);
  return m ? `${m[2]} - ${m[1].trim()}` : mode;
}

// Both "Present Character"/"Real Intention" raw facts and the sensory
// fallback format their character as "N - Name" (sometimes "3.0 - Winner"
// with a decimal from PDF extraction) — pull out just the leading number to
// key CharacterReference lookups, which store a clean integer.
export function parseCharacterNumber(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?)/.exec(label.trim());
  return m ? Math.round(parseFloat(m[1])) : null;
}

// AttributeCodeReference.header and the client's own extracted attribute
// label are usually identical, but occasionally differ by a leading article
// or trailing period ("A perfectionist" vs "Perfectionist.") — normalize
// both sides the same way before matching so those near-miss variants still
// resolve to the vendor's real description instead of silently falling
// through to Gemini.
function normalizeAttrLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^(a|an)\s+/i, "")
    .replace(/[.\s]+$/, "");
}

/**
 * Draws the "Your Journey Overview" chart as real SVG, using actual
 * per-client data — NOT a static image. The tick level for each of the 12
 * columns is the same number as that column's note in the "Past Experiences
 * Shaped Your Thoughts" Code/Value table (client-confirmed mapping: e.g.
 * value 3 for note "C" places column 1's tick at level 3). Age-bracket
 * labels come from the real text under the chart on page 5. When there's no
 * real age timeline (Note Balance fallback), pass `framing: "notes"` to
 * label columns by note instead and drop the age-specific decorations.
 */
function journeyOverviewSvg(values: number[], labels: string[], framing: "age" | "notes" = "age"): string {
  const cols = 12;
  const colGap = 54;
  const leftMargin = 50;
  const topMargin = 20;
  const rowGap = 32;
  const radius = 9;
  const chartWidth = leftMargin + colGap * (cols - 1) + 40;
  const chartHeight = topMargin + rowGap * 6 + 60;

  const colX = (i: number) => leftMargin + i * colGap;
  const rowY = (level: number) => topMargin + (7 - level) * rowGap; // level 7 at top, 1 at bottom

  let circles = "";
  let rowLabels = "";
  for (let level = 1; level <= 7; level++) {
    rowLabels += `<text x="${leftMargin - 30}" y="${rowY(level) + 5}" font-size="13" fill="#374151" text-anchor="middle">${level}</text>`;
    for (let c = 0; c < cols; c++) {
      circles += `<circle cx="${colX(c)}" cy="${rowY(level)}" r="${radius}" fill="none" stroke="${levelColor(level)}" stroke-width="2" />`;
    }
  }

  const points = values.map((v, i) => `${colX(i)},${rowY(v)}`).join(" ");
  const dots = values
    .map((v, i) => `<circle cx="${colX(i)}" cy="${rowY(v)}" r="6" fill="#111827" />`)
    .join("");

  const dividerX = (colX(5) + colX(6)) / 2;

  let colLabels = "";
  labels.forEach((a, i) => {
    colLabels += `<text x="${colX(i)}" y="${topMargin + rowGap * 6 + 40}" font-size="12" fill="#374151" text-anchor="middle">${escapeHtml(a)}</text>`;
  });

  const divider =
    framing === "age"
      ? `<line x1="${dividerX}" y1="${topMargin - 8}" x2="${dividerX}" y2="${topMargin + rowGap * 6 + 8}" stroke="#4338ca" stroke-width="1.5" stroke-dasharray="4 3" />`
      : "";
  const endLabels =
    framing === "age"
      ? `<text x="${leftMargin - 30}" y="${topMargin + rowGap * 6 + 30}" font-size="11" fill="#374151" text-anchor="middle" font-weight="700">NOW</text>
      <text x="${colX(cols - 1) + 25}" y="${topMargin + rowGap * 6 + 30}" font-size="11" fill="#374151" text-anchor="middle" font-weight="700">0</text>`
      : "";

  return `
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" width="100%" style="max-width: 640px">
      ${divider}
      <line x1="${leftMargin - 10}" y1="${topMargin + rowGap * 6 + 12}" x2="${colX(cols - 1) + 10}" y2="${topMargin + rowGap * 6 + 12}" stroke="#1f2937" stroke-width="1.5" />
      ${rowLabels}
      ${circles}
      <polyline points="${points}" fill="none" stroke="#111827" stroke-width="1.5" />
      ${dots}
      ${colLabels}
      ${endLabels}
    </svg>`;
}

/**
 * "Lifepath Emotional Blueprint" — the same data as journeyOverviewSvg above
 * (12 columns, levels 1-7, the client's own value per column), drawn to the
 * one-page overview design instead: solid red/orange/green bands behind a
 * grid of diamonds, with a labelled box row along the bottom axis. The full
 * report keeps the ring-grid version, so this is a second presentation of one
 * dataset rather than a second dataset.
 */
function lifepathBlueprintSvg(values: number[], labels: string[]): string {
  const cols = 12;
  const rows = 7;
  const cellW = 46;
  const rowH = 26;
  const leftPad = 8;
  const topPad = 6;
  const bandW = leftPad * 2 + cols * cellW;
  const bandH = rows * rowH;
  const boxGap = 9;
  const boxH = 21;
  const width = bandW;
  const height = topPad + bandH + boxGap + boxH + 6;

  const colX = (i: number) => leftPad + cellW * i + cellW / 2;
  const rowY = (level: number) => topPad + (rows - level) * rowH + rowH / 2; // 7 at top, 1 at bottom
  // Same green/orange/red thresholds as levelColor(), in the softer fills the
  // design uses for a solid band rather than a thin ring outline.
  const bandFill = (level: number) => (level <= 3 ? "#a7d8a2" : level <= 5 ? "#f2a63f" : "#e3574b");
  const diamond = (x: number, y: number, s: number) => `M ${x} ${y - s} L ${x + s} ${y} L ${x} ${y + s} L ${x - s} ${y} Z`;

  let bands = "";
  let diamonds = "";
  for (let level = rows; level >= 1; level--) {
    bands += `<rect x="0" y="${topPad + (rows - level) * rowH}" width="${bandW}" height="${rowH}" fill="${bandFill(level)}" />`;
    for (let c = 0; c < cols; c++) {
      diamonds += `<path d="${diamond(colX(c), rowY(level), 6.5)}" fill="#ffffff" stroke="#ffffff" stroke-width="1" opacity="0.92" />`;
    }
  }

  // The client's own level per column: a dark diamond on the band, joined by
  // a connecting line, plus a tick down to that column's box.
  const marks = values
    .map((v, i) => `<path d="${diamond(colX(i), rowY(v), 7)}" fill="#1f2937" stroke="#ffffff" stroke-width="1.6" />`)
    .join("");
  const line = `<polyline points="${values.map((v, i) => `${colX(i)},${rowY(v)}`).join(" ")}" fill="none" stroke="#1f2937" stroke-width="1.6" />`;

  const boxTop = topPad + bandH + boxGap;
  let boxes = "";
  for (let c = 0; c < cols; c++) {
    boxes += `<rect x="${colX(c) - cellW / 2 + 4}" y="${boxTop}" width="${cellW - 8}" height="${boxH}" rx="2"
      fill="#ffffff" stroke="#9ca3af" stroke-width="1" />`;
    boxes += `<line x1="${colX(c)}" y1="${topPad + bandH}" x2="${colX(c)}" y2="${boxTop}" stroke="#9ca3af" stroke-width="1" />`;
    if (labels[c]) {
      boxes += `<text x="${colX(c)}" y="${boxTop + boxH / 2 + 4}" font-size="11" font-weight="700" fill="#374151" text-anchor="middle">${escapeHtml(labels[c])}</text>`;
    }
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width: ${width}px">
      <defs>
        <clipPath id="bpClip"><rect x="0" y="${topPad}" width="${bandW}" height="${bandH}" rx="7" /></clipPath>
      </defs>
      <g clip-path="url(#bpClip)">${bands}${diamonds}</g>
      ${line}
      ${marks}
      ${boxes}
    </svg>`;
}

/**
 * Dedicated renderer for assessments built from the "iEmoWave Full" report —
 * follows that report's own page order (Stress Level → Emotional State →
 * Sensory Attributes → Brain Activities → Present Character & Real
 * Intention → Seven Leadership Dynamics → Top 5 Constructive/Restrictive →
 * Wellness Challenge → Journey Overview), per the client's explicit request
 * to match "iEmoWave Full"'s exact layout rather than the generic
 * section-per-fact template used for Aquera/Emotional Notes.
 */
// "finance" used to be a third themed subset here. It's now the Financial
// Wealth Management report — a separate report type with its own renderer and
// vendor data (lib/renderFwmReport.ts) — so it's no longer one of these.
// /api/generate-report still ACCEPTS ?theme=finance and routes it to FWM, so
// links handed out before the switch keep working.
export type ReportTheme = "career" | "relationship";

// "full" is the multi-page detail report; "overview" is a single-page
// summary of the same data — the headline values only, no descriptions.
// Both run through the identical derivation below (reference-table lookups,
// Gemini content, raw-fact fallbacks) and differ only in presentation, so an
// overview can never disagree with the detail report it summarizes.
// "fwm" is handled by renderFwmReport.ts, not by this renderer — it's listed
// here because /api/generate-report validates every variant against one list.
export type ReportVariant = "full" | "overview" | "fwm";

// Which top-level sections each themed report shows — same underlying data
// as the full report, just a different subset emphasized per theme. Brain
// Activities, Sensory Attributes, and Wellness Challenge don't map cleanly
// to any one theme, so they're left out of all three themed variants
// (still shown in the full combined report, i.e. when `theme` is undefined).
const THEME_SECTIONS: Record<ReportTheme, string[]> = {
  career: ["presentCharacter", "leadership", "attributes", "stress"],
  relationship: ["emotionalState", "leadership", "presentCharacter", "attributes"],
};

// "[Base] THE MEDIATOR (9) HEARING FOCUSED INTROVERT D-Major (D) [Chort] THE
// LOYALIST (6.0) HEARING DIRECTED EXTROVERT C-Major (C)" — the Mind Report's
// own combined line. The three ALL-CAPS words after each character number are
// that type's communication/learning style (sense modality, direction,
// orientation), which the overview shows as the base/next attribute lists.
export function parseNinePointsTypes(summary: string): { character: string; attrs: string[] }[] {
  if (!summary) return [];
  const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
  return summary
    .split(/\[[^\]]+\]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((chunk) => {
      const nameMatch = /THE\s+([A-Z][A-Z ]*?)\s*\(/.exec(chunk);
      const attrsMatch = /\([\d.]+\)\s+((?:[A-Z]+\s+){2}[A-Z]+)/.exec(chunk);
      return {
        character: nameMatch ? titleCase(nameMatch[1].trim()) : "",
        attrs: attrsMatch ? attrsMatch[1].trim().split(/\s+/) : [],
      };
    })
    .filter((t) => t.character || t.attrs.length);
}

export async function renderEwFullReportHtml(
  assessment: AssessmentWithFacts,
  theme?: ReportTheme,
  variant: ReportVariant = "full",
): Promise<string> {
  const facts = assessment.facts;
  // No theme (the default, full combined report) shows every section, same
  // as before this existed; a theme restricts to that theme's subset.
  const show = (key: string) => !theme || THEME_SECTIONS[theme].includes(key);
  const num = (n: number) => (theme ? "" : `${n}. `);

  // Top 5 Constructive/Restrictive Attributes — both label and description
  // are AI content (either iEmoWave-Full's own paraphrased descriptions, or,
  // with no iEmoWave-Full upload, Gemini's dedup+summarize pass over the
  // Emotional Notes trait-score categories) computed once at upload time
  // (see refreshFallbackTopAttributes() in saveEnhancedContent.ts) and read
  // here as a plain query, not recomputed on every report view. Raw
  // ReportFact is the fallback only for clients uploaded before this table
  // existed.
  let constructive = assessment.topAttributeContent
    .filter((r) => r.kind === "constructive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ label: r.label, desc: r.description }));
  let restrictive = assessment.topAttributeContent
    .filter((r) => r.kind === "restrictive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ label: r.label, desc: r.description }));
  if (constructive.length === 0) {
    constructive = [1, 2, 3, 4, 5]
      .map((n) => ({ label: fact(facts, `Constructive Attribute ${n}`), desc: fact(facts, `Constructive Attribute ${n} - description`) }))
      .filter((r) => r.label);
  }
  if (restrictive.length === 0) {
    restrictive = [1, 2, 3, 4, 5]
      .map((n) => ({ label: fact(facts, `Restrictive Attribute ${n}`), desc: fact(facts, `Restrictive Attribute ${n} - description`) }))
      .filter((r) => r.label);
  }
  // Applied once here rather than at each render site, so the full report's
  // attribute tables and the overview's top-5 lists can't drift apart.
  constructive = constructive.map((c) => ({ ...c, label: asStatement(c.label) }));
  restrictive = restrictive.map((r) => ({ ...r, label: asStatement(r.label) }));

  const dynamicLabels = [
    "1 - Purpose : Values, Passion, Purpose",
    "2 - Self Awareness : Insights to Beliefs",
    "3 - Self Development : Knowledge to Communicate",
    "4 - Self Management : Relationships to Love",
    "5 - Self Belief : Willpower to Wealth",
    "6 - Self Esteem : Belonging to Pleasure",
    "7 - Being : Experience to Foundation",
  ];
  // Leadership Dynamic ratings come from the Mind Report's own Vortex
  // Energy chart — the 7 vortex rows line up 1:1 with the 7 dynamics by
  // number (row 1 = dynamic 1, etc.) — client-specified mapping, simplified
  // to a plain High/Low/Balance scale (no "Too High"/"Too Low").
  const dynamics = dynamicLabels
    .map((l, i) => ({ label: l, rating: factOrNull(facts, `Vortex Energy - Row ${i + 1}`) }))
    .filter((d) => d.rating);

  const codeValueRaw = fact(facts, "Past Experiences - Code/Value");
  const codeValuePairs = [...codeValueRaw.matchAll(/(\d+)\.\s*(\S+?)=(\d+)/g)].map((m) => ({
    no: m[1],
    code: m[2],
    value: m[3],
  }));
  const journeyValues = codeValuePairs.map((p) => Number(p.value));
  const ageBracketsRaw = fact(facts, "Journey Overview - age brackets");
  const agesFound = ageBracketsRaw ? ageBracketsRaw.split(",").map((s) => s.trim()) : [];
  // Prefer the client's real age (looked up from Quantemo by the admin-
  // entered email — see lib/quantemo.ts) computed into the same 12-bracket
  // countdown the vendor's own chart uses, over the raw PDF-extracted text,
  // which is fragile and sometimes incomplete. Falls back to that raw text,
  // then to blank, when there's no email set or no matching Quantemo row.
  // The SUBJECT's own date of birth wins over the buying account's age. On a
  // report bought by a parent for their child, the Quantemo account is the
  // parent — so without this the child's Journey Overview is labelled with a
  // 40-year-old's brackets, silently and with nothing on the page to show it.
  // Falls back to the account only when the round names no subject, which is
  // every round bought before family profiles existed.
  const subjectAge = assessment.subjectDob ? ageFromDateOfBirth(assessment.subjectDob) : null;
  const quantemoAge =
    subjectAge ?? (assessment.customerEmail ? await lookupQuantemoAge(assessment.customerEmail) : null);
  // The chart itself always plots all 12 ticks (one per Code/Value entry);
  // the age labels below are decoration and some clients' own chart leaves
  // the last one blank (confirmed against the client's reference image) —
  // pad to 12 slots rather than requiring a full set to show the chart at all.
  const ages = quantemoAge !== null ? ageBracketLabels(quantemoAge) : Array.from({ length: 12 }, (_, i) => agesFound[i] ?? "");
  const hasJourneyData = journeyValues.length === 12;

  // No iEmoWave-Full data → fall back to the Emotional Notes report's own
  // "Note Balance" chart (Gemini Vision-read at upload time — see
  // saveEnhancedContent.ts — stored as a plain array, not text to re-parse).
  // Old-format ReportFact text is the fallback only for clients uploaded
  // before this table existed.
  const noteBalanceValues = Array.isArray(assessment.journeyOverviewContent?.noteBalanceValues)
    ? (assessment.journeyOverviewContent!.noteBalanceValues as unknown as number[])
    : [...fact(facts, "Note Balance - values").matchAll(/=(\d+)/g)].map((m) => Number(m[1]));
  const hasNoteBalance = !hasJourneyData && noteBalanceValues.length === 12;

  // When there's no iEmoWave-Full upload for this client, fall back to the
  // Mind Report's own equivalents — the SAME real vendor result, just
  // printed on a different page with different formatting, not invented:
  // "Public Self (C-Major (C))" / "Private Self" are that report's own
  // Note 1 / Note 2, and its "Frequent/Core Emotions" section is the same
  // data the iEmoWave-Full page calls "Frequent/Core Emotion" (no vendor
  // code prefix there, but the same label + description).
  // Both sources go through normalizeNote — the iEmoWave-Full field is
  // usually already a bare note, but running it through too means one set of
  // spelling rules (flats, sharps, Major/Minor) rather than two.
  const note1 = normalizeNote(fact(facts, "Emotional State - Note 1")) || normalizeNote(fact(facts, "Public Self - note"));
  const note2 = normalizeNote(fact(facts, "Emotional State - Note 2")) || normalizeNote(fact(facts, "Private Self - note"));

  // Character is always the vendor's own short label (raw), read here (not
  // just inside the section below) so its number can drive the
  // CharacterReference lookup alongside the report's other vendor-data
  // lookups.
  const presentCharacter = fact(facts, "Present Character") || sensoryFallbackCharacter(facts, "Base");
  const realIntention = fact(facts, "Real Intention") || sensoryFallbackCharacter(facts, "Next");
  const presentCharacterNum = presentCharacter ? parseCharacterNumber(presentCharacter) : null;
  const realIntentionNum = realIntention ? parseCharacterNumber(realIntention) : null;
  const stressScoreForLookup = parseFloat(fact(facts, "Stress Level - score"));

  // Vendor reference-data lookups — canonical, deterministic text keyed by
  // data this report already extracts per-client (a note letter, a
  // character number, a stress score). Checked first, ahead of any
  // Gemini-generated content, in each section below; only falls through to
  // AI content when the reference table has no row (or no matching
  // description) for that key.
  const [note1Ref, note2Ref, presentCharacterRef, realIntentionRef, stressRangeMatch, attributeRefs, emotionRefs] = await Promise.all([
    note1 ? prisma.noteBehaviorReference.findUnique({ where: { note: note1 } }) : null,
    note2 ? prisma.noteBehaviorReference.findUnique({ where: { note: note2 } }) : null,
    presentCharacterNum !== null
      ? prisma.characterReference.findUnique({ where: { language_number: { language: "English", number: presentCharacterNum } } })
      : null,
    realIntentionNum !== null
      ? prisma.characterReference.findUnique({ where: { language_number: { language: "English", number: realIntentionNum } } })
      : null,
    Number.isFinite(stressScoreForLookup)
      ? prisma.stressRangeReference.findFirst({ where: { stressFrom: { lte: stressScoreForLookup }, stressTo: { gt: stressScoreForLookup } } })
      : null,
    prisma.attributeCodeReference.findMany(),
    prisma.emotionCodeReference.findMany(),
  ]);
  const attrByNormalizedHeader = new Map(attributeRefs.filter((a) => a.header).map((a) => [normalizeAttrLabel(a.header!), a]));
  const attrDescFor = (label: string, fallbackDesc: string): string => attrByNormalizedHeader.get(normalizeAttrLabel(label))?.description || fallbackDesc;
  constructive = constructive.map((c) => ({ ...c, desc: attrDescFor(c.label, c.desc) }));
  restrictive = restrictive.map((r) => ({ ...r, desc: attrDescFor(r.label, r.desc) }));

  // Frequent/Core Emotion descriptions resolve the same way the attribute
  // tables above do: the vendor reference table first (keyed by the emotion's
  // own code when the extracted value carries one — "q1: Quiet." — otherwise
  // by its header text), then Gemini content, then the raw extracted text.
  // `explanation` is the reference table's already-paraphrased, ready-to-use
  // column; `description` there is the vendor's own wording, which the report
  // deliberately doesn't reprint verbatim.
  const emotionByCode = new Map(emotionRefs.map((e) => [e.code.trim().toLowerCase(), e]));
  const emotionByHeader = new Map(emotionRefs.filter((e) => e.header).map((e) => [normalizeAttrLabel(e.header!), e]));
  const emotionExplanationFor = (combined: string): string => {
    if (!combined) return "";
    const { code, label } = splitCodeLabel(combined);
    const row =
      (code ? emotionByCode.get(code.trim().toLowerCase()) : undefined) ??
      (label ? emotionByHeader.get(normalizeAttrLabel(label)) : undefined);
    return row?.explanation?.trim() || "";
  };

  const freqEmotion = fact(facts, "Frequent Emotion") || fact(facts, "Frequent Emotion (Mind Report)");
  const freqEmotionDesc =
    emotionExplanationFor(freqEmotion) ||
    assessment.emotionalStateContent?.frequentEmotionDesc ||
    fact(facts, "Frequent Emotion - description") ||
    fact(facts, "Frequent Emotion (Mind Report) - description");
  const coreEmotion = fact(facts, "Core Emotion") || fact(facts, "Core Emotion (Mind Report)");
  const coreEmotionDesc =
    emotionExplanationFor(coreEmotion) ||
    assessment.emotionalStateContent?.coreEmotionDesc ||
    fact(facts, "Core Emotion - description") ||
    fact(facts, "Core Emotion (Mind Report) - description");

  // iEmoWave-Full has a 0-100 stress score for the 5-band gauge; Mind
  // Report has its own real stress-index number (e.g. "2") for a different
  // 6-band gauge (MIND_STRESS_BANDS) — both are real per-client values, not
  // fabricated, just from two different vendor scales. Only when neither
  // exists does the section fall back to text with no gauge at all.
  const stressScore = fact(facts, "Stress Level - score");
  const stressIndex = fact(facts, "Stress index value");
  const stressTypeFact = facts.find((f) => f.label.startsWith("Stress type (") && typeof f.value === "string");
  const stressCategory = stressTypeFact ? stressTypeFact.label.replace(/^Stress type \(|\)$/g, "") : "";
  // Prefer showing an actual number as the big headline (matching the
  // reference report's own visual weight) — the category name becomes a
  // subtitle instead of standing in for the number when there's no score.
  // A bare integer ("4") reads as less polished than the reference report's
  // own one-decimal style ("4.0") — cosmetic only, doesn't touch the
  // underlying value, so it's applied right here rather than at extraction.
  const formatStressNumber = (v: string) => (/^\d+$/.test(v) ? `${v}.0` : v);
  const stressHeading = formatStressNumber(stressScore || stressIndex || stressCategory || "—");
  const stressShowCategory = !stressScore && !!stressIndex && !!stressCategory;
  const stressBody =
    stressScore || stressIndex
      ? stressRangeMatch?.indicator ||
        stressRangeMatch?.descriptionEn ||
        assessment.stressContent?.description ||
        fact(facts, "Stress Level - description") ||
        String(stressTypeFact?.value ?? "")
      : "";

  const lrMatch = /^L=(\d+),\s*R=(\d+)$/.exec(fact(facts, "L/R Brain - values"));
  const lrBrain = lrMatch ? { left: lrMatch[1], right: lrMatch[2] } : null;

  // Trait and Summary prefer the vendor's own CharacterReference lookup
  // (deterministic, keyed by that same character number) — falling through
  // to AI content (either iEmoWave-Full's own paraphrased fields, or the
  // Mind-Report fallback's Gemini-generated trait phrase + paraphrased
  // Sensory paragraph) only when there's no reference-table match. Hoisted
  // out of the section template below so the overview variant reads exactly
  // the same values rather than re-deriving them.
  const presentTrait =
    presentCharacterRef?.presentCharacter ||
    assessment.presentCharacterContent?.presentTrait ||
    fact(facts, "Present Character - trait") ||
    fact(facts, "Sensory persona (Base)");
  const presentSummary =
    presentCharacterRef?.summary ||
    assessment.presentCharacterContent?.presentSummary ||
    fact(facts, "Present Character - summary") ||
    fact(facts, "Sensory - first type (Base)");
  const realTrait =
    realIntentionRef?.presentCharacter ||
    assessment.presentCharacterContent?.realTrait ||
    fact(facts, "Real Intention - trait") ||
    fact(facts, "Sensory persona (Next)");
  const realSummary =
    realIntentionRef?.summary ||
    assessment.presentCharacterContent?.realSummary ||
    fact(facts, "Real Intention - summary") ||
    fact(facts, "Sensory - second type (Next)");

  const note1Reaction =
    note1Ref?.generalReaction ||
    assessment.emotionalStateContent?.note1ReactionDesc ||
    assessment.emotionalStateContent?.publicSelfFull ||
    fact(facts, "Emotional State - Note 1 reaction") ||
    fact(facts, "Public Self - full").replace(/^[A-G]#?-(Major|Minor)\s*\([^)]+\)\s*/, "");
  const note2Reaction =
    note2Ref?.generalReaction ||
    assessment.emotionalStateContent?.note2ReactionDesc ||
    assessment.emotionalStateContent?.privateSelfFull ||
    fact(facts, "Emotional State - Note 2 reaction") ||
    fact(facts, "Private Self - full").replace(/^[A-G]#?-(Major|Minor)\s*\([^)]+\)\s*/, "");

  if (variant === "overview") {
    // Base/Next communication style comes from the Mind Report's own combined
    // "9 Points Type summary" line; the character names it carries are the
    // same ones presentCharacter/realIntention hold, so those stay as the
    // fallback when that fact is absent (e.g. iEmoWave-Full-only clients).
    const ninePoints = parseNinePointsTypes(fact(facts, "9 Points Type summary"));
    // "9 - Mediator" -> "Mediator" — the client's own reference layout shows
    // just the character name in its chip, not the vendor's numbered code.
    const shortCharacterName = (label: string) => label.replace(/^\d+(\.\d+)?\s*-\s*/, "");
    const reportNo = await clientRoundNo(assessment);
    return renderOverviewSvgHtml({
      name: assessment.customerId,
      // The date this report was generated (today), not when the source PDF
      // was first extracted — a client re-downloading their report weeks
      // later should see today's date, not their original upload date.
      date: new Date().toISOString().slice(0, 10),
      reportNo: String(reportNo),
      stressScore,
      stressIndex,
      lrBrain,
      freqLabel: splitCodeLabel(freqEmotion).label,
      freqDesc: freqEmotionDesc,
      coreLabel: splitCodeLabel(coreEmotion).label,
      coreDesc: coreEmotionDesc,
      presentCharacterName: shortCharacterName(ninePoints[0]?.character || presentCharacter),
      realIntentionName: shortCharacterName(ninePoints[1]?.character || realIntention),
      baseAttrs: ninePoints[0]?.attrs ?? [],
      nextAttrs: ninePoints[1]?.attrs ?? [],
      note1,
      note2,
      dynamics: dynamics.map((d) => ({ label: d.label, rating: simplifyRating(d.rating!) })),
      constructive: constructive.map((c) => c.label),
      restrictive: restrictive.map((r) => r.label),
      journeyValues: hasJourneyData ? journeyValues : hasNoteBalance ? noteBalanceToLevels(noteBalanceValues) : [],
      // Real age (from Quantemo) is independent of which data source filled
      // the 12 columns above — a client's age doesn't depend on whether they
      // had an iEmoWave-Full upload. On the real Code/Value chart, `ages`
      // already covers both the Quantemo lookup and the raw-extracted PDF
      // text as a fallback; on the Note Balance fallback chart there's no
      // such PDF text to fall back to, so only show it there when Quantemo
      // actually resolved a real age.
      journeyAges: hasJourneyData ? ages : hasNoteBalance && quantemoAge !== null ? ageBracketLabels(quantemoAge) : [],
    });
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<style>
  * { box-sizing: border-box; }
  html, body { background: #ffffff; }
  body {
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1f2328;
    margin: 0;
    padding: 26px 40px;
  }
  .head-row {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #f16421; padding-bottom: 10px; margin-bottom: 16px;
  }
  .head-meta p { margin: 0 0 4px; font-size: 13px; }
  .head-meta .k { color: #6b7280; margin-right: 6px; }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .logo .emo { color: #1f2328; } .logo .waves { color: #f16421; }
  .logo-tag { font-size: 10px; color: #9ca3af; font-style: italic; text-align: right; margin-top: 2px; }

  .section { margin-bottom: 14px; page-break-inside: avoid; }
  .section h2 {
    font-size: 14px; font-weight: 700; color: #f16421;
    border-bottom: 1px solid #f4c9ae; padding-bottom: 4px; margin: 0 0 8px;
  }
  p { font-size: 12.5px; line-height: 1.45; margin: 0 0 5px; }
  .muted { color: #6b7280; font-size: 11.5px; }

  .pair { display: flex; gap: 12px; }
  .pair-box { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 12px; }
  .pair-label { font-size: 11px; font-weight: 700; color: #f16421; text-transform: uppercase; margin-bottom: 4px; }

  table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-bottom: 4px; }
  th, td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #efefef; font-size: 11.5px; color: #374151; }

  .attr-table td, .attr-table th { font-size: 11.5px; }
  .pc-bar { color: #fff; font-size: 12px; font-weight: 700; padding: 6px 10px; margin-top: 8px; }
  .pc-bar-blue { background: #4a7fc9; }
  .pc-bar-teal { background: #4a9e8f; }
  .pc-table { margin-bottom: 10px; }
  .pc-table th:first-child, .pc-table td:first-child { width: 100px; font-weight: 700; }
  .attr-table .col-no { width: 26px; text-align: center; }
  .attr-restrictive-row { display: flex; gap: 14px; align-items: flex-start; }
  .attr-restrictive-col { flex: 2; }
  .attr-code-col { flex: 1; }
  .attr-code-col table td, .attr-code-col table th { text-align: center; }
  .wellness-row { display: flex; gap: 14px; align-items: flex-start; }
  .wellness-col { flex: 2; }
  .organ-box { flex: 1; background: #f2f2f2; border-radius: 6px; padding: 10px 12px; margin-top: 34px; }
  .organ-heading { font-size: 11px; font-weight: 700; color: #374151; margin-bottom: 4px; }
  .organ-list { font-size: 11.5px; color: #1f2328; line-height: 1.6; }

  .dyn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
  .dyn-bar { color: #fff; font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 4px; }
  .dyn-rating { font-size: 12px; color: #374151; font-weight: 600; margin: 3px 0 2px 10px; }

  ol { margin: 0 0 6px 18px; padding: 0; font-size: 12.5px; line-height: 1.45; }

  .disclaimer {
    margin-top: 20px; background: #f2f2f2; border-radius: 6px; padding: 10px 14px;
    font-size: 9.5px; line-height: 1.4; color: #4b5563;
  }

  .stress-row { display: flex; gap: 12px; align-items: stretch; }
  .stress-score-box { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 14px; }
  .stress-score { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .stress-category { font-size: 12.5px; font-weight: 600; color: #f16421; margin: -2px 0 6px; }
  .stress-gauge-box { flex: 1.3; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; display: flex; align-items: center; }

  .stress-gauges { display: flex; gap: 8px; width: 100%; align-items: flex-start; }
  .gauge-item { flex: 1; text-align: center; }
  .gauge-item:nth-child(even) { margin-top: 22px; }
  .gauge-label {
    display: inline-block; border: 1px solid #d1d5db; border-radius: 14px; padding: 2px 6px;
    font-size: 9px; font-weight: 700; color: #374151; margin-bottom: 3px; line-height: 1.25;
  }
  .gauge-range { font-size: 10px; color: #374151; font-weight: 600; margin-top: 1px; }
  .gauge-item.active .gauge-label { border-color: #f16421; color: #f16421; background: #fff3ec; }
  .gauge-item.active .gauge-range { color: #f16421; }
  .gauge-item svg { width: 44px; height: 44px; }

  /* Behaviour Pattern (wheel + note scale, including its own section
     header) is the real reference SVG cropped to that band — see
     renderBehaviourPatternFragment() — so this wrapper only needs to
     separate it from the section above and cap its width. */
  .rhythmic-real { margin-top: 10px; border-top: 1px solid #f4c9ae; padding-top: 8px; max-width: 900px; }

  .empower-row { display: flex; gap: 4px; margin: 6px 0; }
  .empower-box { flex: 1; border-radius: 4px; padding: 5px 10px; color: #fff; text-align: center; }
  .empower-box .empower-heading { font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .empower-box .empower-value { font-size: 12px; font-weight: 700; margin-top: 1px; }

  /* Sits directly under the section heading, above the Note 1/2 tables —
     the extra bottom margin keeps it visually separate from them. */
  .emo-pair { display: flex; gap: 12px; margin: 6px 0 12px; }
  .emo-col { flex: 1; }
  .emo-col-head { font-size: 11px; font-weight: 700; color: #f16421; }
  .emo-col-sub { font-size: 9.5px; color: #6b7280; margin-bottom: 4px; }
  .emo-code-row { display: flex; gap: 4px; margin-bottom: 4px; }
  .emo-code { width: 34px; flex: 0 0 auto; border: 1px solid #e5e7eb; border-radius: 4px; padding: 4px; text-align: center; font-size: 11.5px; font-weight: 700; color: #374151; }
  .emo-label { flex: 1; border: 1px solid #e5e7eb; border-radius: 4px; padding: 4px 8px; font-size: 12px; font-weight: 600; }
  .emo-desc { border: 1px solid #e5e7eb; border-radius: 4px; padding: 5px 8px; font-size: 11.5px; color: #2563eb; line-height: 1.35; }
  .empower-box.up { background: #2e9e4f; }
  .empower-box.down { background: #e0653c; }

  .extra-sections { margin-top: 28px; border-top: 2px solid #f16421; padding-top: 18px; page-break-before: always; }
  .extra-sections-title { font-size: 17px; font-weight: 700; color: #1f2328; margin: 0 0 18px; }
  .fact { margin-bottom: 14px; }
  .fact h3 { font-size: 13px; margin: 0 0 4px; color: #374151; }
  .fact-value { font-size: 13px; line-height: 1.6; margin: 0; white-space: pre-line; }
  .fact-table { border-collapse: collapse; font-size: 13px; }
  .fact-table td { padding: 2px 10px 2px 0; }
  .fact-table td.k { color: #6b7280; }
  .lr-table { border-collapse: collapse; width: 100%; margin-top: 4px; }
  .lr-table th, .lr-table td { border: 1px solid #e5e7eb; padding: 6px 12px; text-align: center; }
  .lr-table th { background: #efefef; font-size: 12px; color: #374151; }
  .lr-table td { font-size: 15px; font-weight: 600; }
  .section.locked { background: #f9fafb; border-radius: 8px; padding: 16px; }
  .lock-teaser { color: #9ca3af; font-size: 13px; text-align: center; padding: 20px 0; }
</style>
</head>
<body>
  <div class="head-row">
    <div class="head-meta">
      <p><span class="k">Name:</span>${escapeHtml(assessment.customerId)}</p>
      <p><span class="k">Date:</span>${new Date().toISOString().slice(0, 10)}</p>
    </div>
    <div>
      <div class="logo"><span class="emo">Emo</span><span class="waves">Waves</span></div>
      <div class="logo-tag">${theme ? `${theme[0].toUpperCase()}${theme.slice(1)} Focus` : "Your journey, understood"}</div>
    </div>
  </div>

  ${
    show("stress")
      ? `<section class="section">
    <h2>${num(1)}Your Stress Level</h2>
    <div class="stress-row">
      <div class="stress-score-box">
        <div class="stress-score"${stressScore || stressIndex ? "" : ' style="font-size:16px"'}>${escapeHtml(stressHeading)}</div>
        ${stressShowCategory ? `<div class="stress-category">${escapeHtml(stressCategory)}</div>` : ""}
        <p>${escapeHtml(stressBody)}</p>
      </div>
      ${
        stressScore
          ? `<div class="stress-gauge-box">
        ${stressGaugesHtml(stressScore)}
      </div>`
          : stressIndex
            ? `<div class="stress-gauge-box">
        ${mindStressGaugesHtml(stressIndex)}
      </div>`
            : ""
      }
    </div>
  </section>`
      : ""
  }

  ${
    show("emotionalState")
      ? `<section class="section">
    <h2>${num(2)}Your Emotional State</h2>
    <div class="emo-pair">
      <div class="emo-col">
        <div class="emo-col-head">Frequent Emotion:</div>
        <div class="emo-col-sub">The emotion that keeps showing up.</div>
        <div class="emo-code-row">
          ${splitCodeLabel(freqEmotion).code ? `<div class="emo-code">${escapeHtml(splitCodeLabel(freqEmotion).code)}</div>` : ""}
          <div class="emo-label">${escapeHtml(splitCodeLabel(freqEmotion).label)}</div>
        </div>
        ${freqEmotionDesc ? `<div class="emo-desc">${escapeHtml(freqEmotionDesc)}</div>` : ""}
      </div>
      <div class="emo-col">
        <div class="emo-col-head">Core Emotion:</div>
        <div class="emo-col-sub">Strongest emotion underneath the frequent emotion.</div>
        <div class="emo-code-row">
          ${splitCodeLabel(coreEmotion).code ? `<div class="emo-code">${escapeHtml(splitCodeLabel(coreEmotion).code)}</div>` : ""}
          <div class="emo-label">${escapeHtml(splitCodeLabel(coreEmotion).label)}</div>
        </div>
        ${coreEmotionDesc ? `<div class="emo-desc">${escapeHtml(coreEmotionDesc)}</div>` : ""}
      </div>
    </div>
    <table>
      <thead><tr><th>Note 1</th><th>General Reaction</th></tr></thead>
      <tbody><tr><td>${escapeHtml(note1)}</td><td>${escapeHtml(note1Reaction)}</td></tr></tbody>
    </table>
    <table>
      <thead><tr><th>Note 2</th><th>General Reaction</th></tr></thead>
      <tbody><tr><td>${escapeHtml(note2)}</td><td>${escapeHtml(note2Reaction)}</td></tr></tbody>
    </table>

    ${
      (() => {
        const empowering = assessment.emotionalStateContent?.empoweringDesc || fact(facts, "Empowering Emotion");
        const disempowering = assessment.emotionalStateContent?.disempoweringDesc || fact(facts, "Dis-empowering Emotion");
        return empowering || disempowering
          ? `<div class="empower-row">
      <div class="empower-box up">
        <div class="empower-heading">Empowering</div>
        <div class="empower-value">${escapeHtml(empowering)}</div>
      </div>
      <div class="empower-box down">
        <div class="empower-heading">Dis-empowering</div>
        <div class="empower-value">${escapeHtml(disempowering)}</div>
      </div>
    </div>`
          : "";
      })()
    }

    ${
      note1 || note2
        ? `<div class="rhythmic-real">
      ${renderBehaviourPatternFragment(note1, note2)}
    </div>`
        : ""
    }
  </section>`
      : ""
  }

  ${
    show("sensoryAttributes") && fact(facts, "Sensory Attributes - BASE")
      ? `<section class="section">
    <h2>3. Your Present Sensory Attributes</h2>
    <div class="pair">
      <div class="pair-box"><div class="pair-label">Base</div>${escapeHtml(assessment.sensoryAttributesContent?.baseDesc || fact(facts, "Sensory Attributes - BASE"))}</div>
      <div class="pair-box"><div class="pair-label">Next</div>${escapeHtml(assessment.sensoryAttributesContent?.nextDesc || fact(facts, "Sensory Attributes - NEXT"))}</div>
    </div>
  </section>`
      : ""
  }

  ${
    show("brainActivities")
      ? `<section class="section">
    <h2>4. Brain Activities</h2>
    <table class="lr-table">
      <thead><tr><th>Left</th><th>Right</th></tr></thead>
      <tbody><tr><td>${escapeHtml(lrBrain?.left ?? "—")}</td><td>${escapeHtml(lrBrain?.right ?? "—")}</td></tr></tbody>
    </table>
  </section>`
      : ""
  }

  ${
    show("presentCharacter")
      ? `<section class="section">
    <h2>${num(5)}Present Character and Real Intention</h2>
    ${
      (() => {
        // Character is always the vendor's own short label (raw, parsed
        // above into presentCharacter/realIntention); trait/summary are
        // derived above and shared with the overview variant.
        return `${
          presentCharacter
            ? `<div class="pc-bar pc-bar-blue">Present Character</div>
    <table class="attr-table pc-table">
      <thead><tr><th>Character</th><th>Present Character</th><th>Summary</th></tr></thead>
      <tbody><tr><td>${escapeHtml(presentCharacter)}</td><td>${escapeHtml(presentTrait)}</td><td>${escapeHtml(presentSummary)}</td></tr></tbody>
    </table>`
            : ""
        }
    ${
      realIntention
        ? `<div class="pc-bar pc-bar-teal">Real Intention</div>
    <table class="attr-table pc-table">
      <thead><tr><th>Character</th><th>Real Intention</th><th>Summary</th></tr></thead>
      <tbody><tr><td>${escapeHtml(realIntention)}</td><td>${escapeHtml(realTrait)}</td><td>${escapeHtml(realSummary)}</td></tr></tbody>
    </table>`
        : ""
    }`;
      })()
    }
  </section>`
      : ""
  }

  ${
    show("leadership")
      ? `<section class="section">
    <h2>${num(6)}The Seven Leadership Dynamics</h2>
    <div class="dyn-grid">
      ${dynamics
        .map(
          (d, i) => `
        <div class="dyn-cell">
          <div class="dyn-bar" style="background:${["#8e6fb0", "#7d8fc7", "#6fa8b0", "#7fae6f", "#e0c15c", "#e0a15c", "#d97a5c"][i % 7]}">${escapeHtml(d.label)}</div>
          <div class="dyn-rating">${escapeHtml(simplifyRating(d.rating!))}</div>
        </div>`,
        )
        .join("")}
    </div>
  </section>`
      : ""
  }

  ${
    show("attributes") && constructive.length > 0
      ? `<section class="section">
    <h2>Your Top 5 Constructive Attributes</h2>
    <p class="muted">You are consciously aware of your constructive attributes; you are aware that the action you take will
    empower you to create possibilities. These are the areas where you feel positive with high energy.</p>
    <table class="attr-table">
      <thead><tr><th class="col-no">No.</th><th>Constructive</th><th>Description</th></tr></thead>
      <tbody>
        ${constructive
          .map((c, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(c.label)}</td><td>${escapeHtml(c.desc)}</td></tr>`)
          .join("")}
      </tbody>
    </table>
  </section>`
      : ""
  }

  <div class="attr-restrictive-row">
    ${
      show("attributes") && restrictive.length > 0
        ? `<section class="section attr-restrictive-col">
      <h2>Your Top 5 Restrictive Attributes</h2>
      <p class="muted">Past incidents could be a block to your present actions. These are the areas that potentially trigger
      some unpleasant memories and they will shape your behaviour in line with your thoughts.</p>
      <table class="attr-table">
        <thead><tr><th class="col-no">No.</th><th>Restrictive</th><th>Description</th></tr></thead>
        <tbody>
          ${restrictive
            .map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.desc)}</td></tr>`)
            .join("")}
        </tbody>
      </table>
    </section>`
        : ""
    }
    ${
      show("journey") && codeValuePairs.length > 0
        ? `<section class="section attr-code-col">
      <h2>Past Experiences Shaped Your Thoughts</h2>
      <table class="attr-table">
        <thead><tr><th>Code</th><th>Value</th></tr></thead>
        <tbody>
          ${codeValuePairs.map((p) => `<tr><td>${p.no}. ${escapeHtml(p.code)}</td><td>${escapeHtml(p.value)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>`
        : ""
    }
  </div>

  ${
    (() => {
      // AI content (paraphrased descriptions) computed once at upload time
      // and read here as a plain query — see saveEnhancedContent.ts. Raw
      // ReportFact is the fallback only for clients uploaded before this
      // table existed.
      let wellnessRows = assessment.wellnessChallengeContent
        .sort((a, b) => a.rank - b.rank)
        .map((r) => ({ label: r.label, desc: r.description }));
      if (wellnessRows.length === 0) {
        wellnessRows = [1, 2, 3, 4, 5]
          .map((n) => ({ label: fact(facts, `Wellness Challenge ${n}`), desc: fact(facts, `Wellness Challenge ${n} - description`) }))
          .filter((r) => r.label);
      }
      if (!show("wellness") || wellnessRows.length === 0) return "";
      return `<div class="wellness-row">
    <section class="section wellness-col">
      <h2>Potential Mental &amp; Physical Wellness Challenge</h2>
      <table class="attr-table">
        <thead><tr><th class="col-no">#</th><th>Wellness</th><th>Description</th></tr></thead>
        <tbody>
          ${wellnessRows.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.desc)}</td></tr>`).join("")}
        </tbody>
      </table>
    </section>
    ${
      fact(facts, "Wellness - Organ Indicators")
        ? `<div class="organ-box">
      <div class="organ-heading">Organs Indicators</div>
      <div class="organ-list">${escapeHtml(fact(facts, "Wellness - Organ Indicators"))}</div>
    </div>`
        : ""
    }
  </div>`;
    })()
  }

  ${
    !show("journey")
      ? ""
      : hasJourneyData
        ? `<section class="section">
    <h2>${num(8)}Your Journey Overview</h2>
    <p class="muted">Green = constructive, orange = accumulated, red = restrictive — each column's level comes directly from this client's own Past Experiences data.</p>
    ${journeyOverviewSvg(journeyValues, ages)}
  </section>`
        : hasNoteBalance
          ? `<section class="section">
    <h2>${num(8)}Your Journey Overview</h2>
    <p class="muted">${
      quantemoAge !== null
        ? "Your own Note Balance across the 12-note scale, plotted against your age."
        : "Your own Note Balance across the 12-note scale — read from your Emotional Notes report."
    }</p>
    ${
      quantemoAge !== null
        ? journeyOverviewSvg(noteBalanceToLevels(noteBalanceValues), ageBracketLabels(quantemoAge))
        : journeyOverviewSvg(noteBalanceToLevels(noteBalanceValues), NOTE_SCALE, "notes")
    }
  </section>`
          : ""
  }

  <div class="disclaimer">
    This report is generated from your voice-analysis data for self-reflection and personal-growth purposes.
    It is not medical, psychological, financial, or legal advice, and should not be treated as a diagnosis or
    professional recommendation. If you have concerns about your health or wellbeing, please consult an
    appropriately qualified professional.
  </div>
</body>
</html>`;
}
