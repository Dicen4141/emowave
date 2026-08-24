import type { ReportFact } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fwmOverviewParagraphs } from "./fwmOverview";
import { PROSE_MODEL } from "./gemini";
import { REPORT_FONT_FACES } from "./reportFonts";
import {
  escapeHtml,
  fact,
  normalizeNote,
  parseCharacterNumber,
  parseNinePointsTypes,
  clientRoundNo,
  sensoryFallbackCharacter,
  splitCodeLabel,
  type AssessmentWithFacts,
} from "./renderEwFullReport";
import type { PdfChrome } from "./renderReportPdf";

/**
 * The Financial Wealth Management (FWM) report — "EmoWave 5.0", a separate
 * report TYPE from the EmoWave Full report rather than a themed subset of it.
 *
 * Section order, nesting and topic-line wording follow the vendor's own
 * template (v1.0-Emowave-FWM Report.docx). That template is a mapping spec: it
 * names, for each block, the workbook sheet and column the copy comes from. So
 * every sentence this renders is vendor-authored text read out of the fwm_*
 * reference tables — nothing here is model-generated, and the renderer never
 * paraphrases. The one exception is the opening overview, which the template
 * explicitly marks as AI-written; it is left as a placeholder until that is
 * wired up deliberately.
 *
 * All seven lookups key off values the existing extraction pipeline already
 * produces, so no new per-client data has to be captured for this report.
 */

// The template's Comm_Learn / Decision_Making keys are written as
// "<MODALITY> + <Outward|Inward> + <Extrovert|Introvert>", but the Mind
// Report's own "9 Points Type summary" line spells the middle term DIRECTED /
// FOCUSED. They're the same axis under two names: the vendor's
// Sensory_Explaination sheet defines Outward as "the external environment
// significantly impacts the information received" (matching DIRECTED —
// information arriving from outside in) and Inward as "highly self-focused"
// (matching FOCUSED). Without this translation every Comm_Learn lookup misses.
const DIRECTION_TO_TEMPLATE: Record<string, string> = { DIRECTED: "Outward", FOCUSED: "Inward" };
const ORIENTATION_TO_TEMPLATE: Record<string, string> = { EXTROVERT: "Extrovert", INTROVERT: "Introvert" };
const MODALITIES = new Set(["VISUAL", "FEELING", "THINKING", "HEARING"]);

/**
 * Builds one "FEELING + Outward + Extrovert" key from the three ALL-CAPS
 * attribute words the Mind Report prints after each character number.
 * Returns "" when any of the three is missing or unrecognised — a partial key
 * would silently match nothing, and a blank is easier to report as a gap.
 */
function sensoryKey(attrs: string[]): string {
  const modality = attrs.find((a) => MODALITIES.has(a.toUpperCase()))?.toUpperCase();
  const direction = attrs.map((a) => DIRECTION_TO_TEMPLATE[a.toUpperCase()]).find(Boolean);
  const orientation = attrs.map((a) => ORIENTATION_TO_TEMPLATE[a.toUpperCase()]).find(Boolean);
  return modality && direction && orientation ? `${modality} + ${direction} + ${orientation}` : "";
}

function reportDate(): string {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The running header/footer for the FWM PDF — repeated on every page, unlike
 * the report's own <header> hero and closing <footer> note, which are single
 * document elements that print once.
 *
 * These are Puppeteer header/footer templates, not ordinary page markup: they
 * are rendered in an isolated context, so no stylesheet or webfont from the
 * report reaches them and every rule has to be inlined. Chrome also defaults
 * them to font-size 0, so each text element sets its own size explicitly, and
 * -webkit-print-color-adjust keeps the accent colour from being dropped.
 * .pageNumber / .totalPages are the two spans Chrome fills in per page.
 *
 * Horizontal padding is 72px to line the chrome up with the body text column:
 * the 20px page margin below plus main's own 52px inner padding.
 */
export function fwmPdfChrome(assessment: AssessmentWithFacts): PdfChrome {
  const client = escapeHtml(assessment.customerId);
  const generatedOn = escapeHtml(reportDate());
  const frame =
    "-webkit-print-color-adjust:exact; width:100%; margin:0; " +
    "font-family:Arial,Helvetica,sans-serif; font-size:8.5px; color:#6b7280;";
  const row = "display:flex; align-items:baseline; justify-content:space-between; gap:20px;";

  return {
    headerTemplate: `<div style="${frame} padding:10px 72px 0;">
      <div style="${row} border-bottom:1px solid #e5e7eb; padding-bottom:6px;">
        <span style="font-size:9.5px; font-weight:700; letter-spacing:.09em; color:#5b3fa8;">EMOWAVE 5.0</span>
        <span style="font-size:8.5px;">Financial Wealth Management (FWM) Report</span>
      </div>
    </div>`,
    footerTemplate: `<div style="${frame} padding:0 72px 10px;">
      <div style="${row} border-top:1px solid #e5e7eb; padding-top:6px;">
        <span style="font-size:8.5px;">Confidential — prepared for ${client} · ${generatedOn}</span>
        <span style="font-size:8.5px; white-space:nowrap;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    </div>`,
    // Deep enough for the templates above; Chrome clips whatever overflows.
    margin: { top: "64px", bottom: "56px" },
  };
}

/**
 * "THINKING + Outward + Introvert" -> "Thinking · Outward · Introvert". The
 * workbook's key format is a lookup string, not something to show a client.
 */
function prettySensory(key: string): string {
  if (!key) return "—";
  return key
    .split("+")
    .map((part) => { const w = part.trim(); return w.charAt(0) + w.slice(1).toLowerCase(); })
    .join(" · ");
}

type Block = { title: string; body: string; source: string; note?: string };
type Group = { title: string; blurb: string; blocks: Block[] };

// Above this many characters a block is treated as long-form copy that may
// flow across a page boundary (see .fwm-block--flow). Below it, the block is
// kept whole. Tuned so the multi-paragraph vendor sections flow while the
// one-line lookups (a character summary, a coaching note) stay atomic.
const BLOCK_FLOW_CHARS = 600;

function blockHtml(b: Block): string {
  if (!b.body.trim()) {
    return `<div class="fwm-block fwm-gap">
      <h4>${escapeHtml(b.title)}</h4>
      <p class="fwm-gap-msg">Not included in this report.</p>
      <div class="fwm-src">${escapeHtml(b.source)}</div>
    </div>`;
  }
  const paras = b.body
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
  const flow = b.body.length > BLOCK_FLOW_CHARS ? " fwm-block--flow" : "";
  return `<div class="fwm-block${flow}">
    <h4>${escapeHtml(b.title)}</h4>
    ${paras}
    ${b.note ? `<p class="fwm-note">${escapeHtml(b.note)}</p>` : ""}
    <div class="fwm-src">${escapeHtml(b.source)}</div>
  </div>`;
}

function groupHtml(g: Group): string {
  return `<div class="fwm-group">
    <div class="group-head">
      <h3>${escapeHtml(g.title)}</h3>
      ${g.blurb ? `<p class="fwm-group-blurb">${escapeHtml(g.blurb)}</p>` : ""}
    </div>
    ${g.blocks.map(blockHtml).join("")}
  </div>`;
}

export async function renderFwmReportHtml(
  assessment: AssessmentWithFacts,
  refreshOverview = false,
): Promise<string> {
  const facts: ReportFact[] = assessment.facts;

  // ---- Resolve this client's seven lookup keys -----------------------------
  // Present Character / Real Intention: the explicit facts when present,
  // otherwise the Mind Report's own "Sensory personality mode" lines — the
  // same precedence the EmoWave Full report uses, so the two reports can never
  // disagree about a client's type.
  const presentCharacterLabel = fact(facts, "Present Character") || sensoryFallbackCharacter(facts, "Base");
  const realIntentionLabel = fact(facts, "Real Intention") || sensoryFallbackCharacter(facts, "Next");
  const presentType = presentCharacterLabel ? parseCharacterNumber(presentCharacterLabel) : null;
  const realType = realIntentionLabel ? parseCharacterNumber(realIntentionLabel) : null;

  // iEmoWave-Full's 0-100 stress score when the client has that upload,
  // otherwise the Mind Report's own stress index. Both are read against the
  // same percentage bands the workbook defines.
  const stressScore = parseFloat(fact(facts, "Stress Level - score") || fact(facts, "Stress index value"));

  const note1 = normalizeNote(fact(facts, "Emotional State - Note 1")) || normalizeNote(fact(facts, "Public Self - note"));
  const note2 = normalizeNote(fact(facts, "Emotional State - Note 2")) || normalizeNote(fact(facts, "Private Self - note"));

  const ninePoints = parseNinePointsTypes(fact(facts, "9 Points Type summary"));
  const baseKey = sensoryKey(ninePoints[0]?.attrs ?? []);
  const nextKey = sensoryKey(ninePoints[1]?.attrs ?? []);

  const freqEmotion = fact(facts, "Frequent Emotion") || fact(facts, "Frequent Emotion (Mind Report)");
  const coreEmotion = fact(facts, "Core Emotion") || fact(facts, "Core Emotion (Mind Report)");

  // ---- Fetch every reference row in one round trip -------------------------
  const [stress, present, real, comm, decision, noteCombo, emotionRefs] = await Promise.all([
    Number.isFinite(stressScore)
      ? prisma.fwmStressRange.findFirst({ where: { stressFrom: { lte: stressScore }, stressTo: { gt: stressScore } } })
      : null,
    presentType !== null ? prisma.fwmPresentCharacter.findUnique({ where: { type: presentType } }) : null,
    realType !== null ? prisma.fwmRealIntention.findUnique({ where: { type: realType } }) : null,
    baseKey ? prisma.fwmCommLearn.findUnique({ where: { base: baseKey } }) : null,
    baseKey && nextKey ? prisma.fwmDecisionMaking.findUnique({ where: { baseNext: `${baseKey} - ${nextKey}` } }) : null,
    note1 && note2 ? prisma.fwmNoteCombination.findUnique({ where: { note1_note2: { note1, note2 } } }) : null,
    // Frequent/Core Emotions reuse the existing emotion_code_reference: the
    // FWM workbook's Frequent_Core_Emotion sheet has the identical 38 codes
    // and columns, so duplicating it into an fwm_* table would just create a
    // second copy to keep in sync.
    prisma.emotionCodeReference.findMany(),
  ]);

  // Keyed by character NAME rather than type number, so it has to wait for the
  // two rows above to resolve. Returns null for the 19 pairings the workbook
  // doesn't ship (anything involving "Seeker") — rendered as a gap, not an error.
  const combination =
    present && real
      ? await prisma.fwmCombination.findUnique({
          where: {
            presentCharacter_realIntention: { presentCharacter: present.character, realIntention: real.character },
          },
        })
      : null;

  const emotionByCode = new Map(emotionRefs.map((e) => [e.code.trim().toLowerCase(), e]));
  const emotionByHeader = new Map(
    emotionRefs.filter((e) => e.header).map((e) => [e.header!.trim().toLowerCase().replace(/[.\s]+$/, ""), e]),
  );
  /** Resolves "i2: Introvert and insecure." (or bare header text) to its row. */
  function emotionRow(combined: string) {
    if (!combined) return null;
    const { code, label } = splitCodeLabel(combined);
    return (
      (code ? emotionByCode.get(code.trim().toLowerCase()) : undefined) ??
      emotionByHeader.get((label || combined).trim().toLowerCase().replace(/[.\s]+$/, "")) ??
      null
    );
  }
  const freqRow = emotionRow(freqEmotion);
  const coreRow = emotionRow(coreEmotion);

  /**
   * 12 of the 37 emotion codes carry a header but no description — the vendor
   * never wrote one, in the FWM workbook or the base one — so both columns
   * render and a missing description costs a line rather than the whole block.
   *
   * Not every extracted emotion matches a code either: the Mind Report prints
   * its own wording, and variants like "Anxiety, fear of failure." sit between
   * two real rows ("Anxiety." / "Anxious, afraid to fail.") without equalling
   * either. The client's own extracted text is the fallback there, matching
   * what the EmoWave Full report does rather than blanking the section.
   */
  function emotionBody(row: { header: string | null; description: string | null } | null, raw: string): string {
    if (row) return [row.header, row.description].filter(Boolean).join("\n");
    return raw ? splitCodeLabel(raw).label || raw : "";
  }

  const S_STRESS = "DataStress_FWM → All_Stress_Types";
  const S_PRESENT = "Characteristics_FWM_DataSet → Present Characters";
  const S_INTENT = "Characteristics_FWM_DataSet → Real Intention";
  const S_COMBO = "Characteristics_FWM_DataSet → Combination";
  const S_EMO = "EQ_Behaviour → Frequent_Core_Emotion";
  const S_NOTE = "EQ_Behaviour → CombineMusicalNote";
  const S_COMM = "DataStress_FWM → Comm_Learn";
  const S_DECIDE = "DataStress_FWM → Decision_Making";

  // ---- Mental Health Assessment (MHA) --------------------------------------
  const mha: Group[] = [
    {
      title: "Life Stressors",
      blurb: "",
      blocks: [
        { title: "Indicator", body: stress?.indicator ?? "", source: `${S_STRESS} → "Indicator"` },
        {
          title: "Financial Intelligence",
          body: stress?.financialIntelligence ?? "",
          source: `${S_STRESS} → "Financial Intelligence"`,
        },
      ],
    },
    {
      title: "Financial Character Assessment",
      blurb: present?.presentCharacter
        ? `How others perceive you as "${present.presentCharacter}".`
        : "How others perceive your present character.",
      blocks: [
        {
          title: present?.presentCharacter ? `${present.presentCharacter} — Summary` : "Summary",
          body: present?.summary ?? "",
          source: `${S_PRESENT} → "Present Character" + "Summary"`,
        },
        {
          title: "Financial Personality, as projected to others",
          body: present?.financialPersonality ?? "",
          source: `${S_PRESENT} → "Financial Personality in via from others"`,
        },
        {
          title: "Subconscious Money Behaviors & Triggers",
          body: present?.subconsciousMoneyBehaviors ?? "",
          source: `${S_PRESENT} → "Subconscious Money Behaviors & Triggers"`,
        },
        {
          title: "Potential Finance Challenges",
          body: present?.potentialFinanceChallenges ?? "",
          source: `${S_PRESENT} → "Potential Finance Challenges"`,
        },
      ],
    },
    {
      title: "Underlying Drivers of Financial Objectives",
      blurb: real?.realIntention ? `Your real intention: "${real.realIntention}".` : "Your real intention.",
      blocks: [
        { title: "Summary", body: real?.summary ?? "", source: `${S_INTENT} → "Summary"` },
        {
          title: "Creating Your Core Values",
          body: real?.coreValues ?? "",
          source: `${S_INTENT} → "Creating Your Core Values"`,
        },
        { title: "Motivate Yourself", body: real?.motivateYourself ?? "", source: `${S_INTENT} → "Motivate Yourself"` },
        {
          title: "Defining the Challenge",
          body: real?.definingChallenge ?? "",
          source: `${S_INTENT} → "Defining the Challenge"`,
        },
        // The template writes 'Potential Career Paths (...) "Grow Path"', but
        // Grow Path holds a transformation statement ("From fear to courage.")
        // while Possible Career holds actual careers. Both render until the
        // template's author confirms which was meant.
        {
          title: "Potential Career Paths",
          body: real?.possibleCareer ?? "",
          source: `${S_INTENT} → "Possible Career"`,
          note: "These are suggestions and require your own validation/acknowledgment.",
        },
        { title: "Grow Path", body: real?.growPath ?? "", source: `${S_INTENT} → "Grow Path"` },
        {
          title: "Financial Behaviour Pattern",
          body: combination?.financialBehaviourPattern ?? "",
          source: `${S_COMBO} → "Financial Behaviour Pattern"`,
        },
        {
          title: "Career in Your Thought Process",
          body: combination?.careerThoughtProcess ?? "",
          source: `${S_COMBO} → "Career in your thought process"`,
        },
        {
          title: "Areas to be Coached — Targeted Financial Wellness Coaching Pathway",
          body: present?.coachingPathway ?? "",
          source: `${S_PRESENT} → "Targeted Financial Wellness Coaching Pathway"`,
        },
      ],
    },
    {
      title: "Social Influence",
      blurb: "Understanding how peer behavior patterns affect an individual's financial habits.",
      blocks: [
        { title: "Social Influence", body: present?.socialInfluence ?? "", source: `${S_PRESENT} → "Social Influence"` },
      ],
    },
  ];

  // ---- Emotional Analysis (EMA) --------------------------------------------
  const ema: Group[] = [
    {
      title: "Emotional Intelligence (EQ)",
      blurb: "Measuring the foundational EQ that governs interpersonal financial relationships.",
      blocks: [
        {
          title: "Frequent Emotions",
          body: emotionBody(freqRow, freqEmotion),
          source: freqRow ? `${S_EMO} → "Header" + "Description" (code ${freqRow.code})` : "Client's own extracted wording — no matching emotion code",
        },
        {
          title: "Core Emotions",
          body: emotionBody(coreRow, coreEmotion),
          source: coreRow ? `${S_EMO} → "Header" + "Description" (code ${coreRow.code})` : "Client's own extracted wording — no matching emotion code",
        },
        {
          title: "Behavior Pattern",
          body: noteCombo?.behaviorPattern ?? "",
          source: `${S_NOTE} → "Behavior Pattern"${note1 && note2 ? ` (${note1} + ${note2})` : ""}`,
        },
        {
          title: "Financial Behavior",
          body: noteCombo?.financialBehavior ?? "",
          source: `${S_NOTE} → "Financial Behavior"${note1 && note2 ? ` (${note1} + ${note2})` : ""}`,
        },
      ],
    },
    {
      title: "Proficiency & Communication Style",
      blurb: baseKey ? `How you take information in: ${prettySensory(baseKey)}.` : "How you take information in.",
      blocks: [
        { title: "Communication Style", body: comm?.communicationStyle ?? "", source: `${S_COMM} → "Communication Style"` },
        { title: "Your Unique Learning Style", body: comm?.learningStyle ?? "", source: `${S_COMM} → "Learning Style"` },
        {
          title: "Your Decision-Making Framework",
          body: decision?.decisionMaking ?? "",
          source: `${S_DECIDE} → "Decision making"`,
        },
        { title: "Financial Choice", body: decision?.financialChoice ?? "", source: `${S_DECIDE} → "Financial Choice"` },
      ],
    },
    {
      title: "Environmental Factors",
      blurb: "Tracking how the current financial environment influences the client's emotional state in real-time.",
      blocks: [
        {
          title: "Environmental Factors",
          body: "",
          source: "No source sheet — specified in the template but not supplied by any workbook",
        },
      ],
    },
  ];

  // Two audiences, one page. The client reads their profile in words; staff
  // read the raw lookup keys those words were resolved from, on screen only —
  // the same split the .fwm-src provenance badges already use. The old single
  // table printed the keys themselves ("band [12, 21)", "THINKING + Outward +
  // Introvert", "m1"), which is diagnostic output sitting in a deliverable.
  const profileRows: [string, string][] = [
    ["Stress index", Number.isFinite(stressScore) ? String(stressScore) : "—"],
    ["Present character", present ? present.character : "—"],
    ["Real intention", real ? real.character : "—"],
    ["How you take information in", prettySensory(baseKey)],
    ["How you reach a decision", prettySensory(nextKey)],
    ["Emotional notes", note1 && note2 ? `${note1} + ${note2}` : "—"],
    [
      "Frequent / core emotion",
      [splitCodeLabel(freqEmotion).label, splitCodeLabel(coreEmotion).label].filter(Boolean).join(" · ") || "—",
    ],
  ];

  // Every key this report looked up, for staff checking a render against the
  // workbook. Screen-only, like the per-block source badges.
  const lookupKeys = [
    stress ? `stress band [${stress.stressFrom}, ${stress.stressTo})` : "stress band: none",
    present ? `present type ${present.type}` : "present character: none",
    real ? `real type ${real.type}` : "real intention: none",
    baseKey ? `base "${baseKey}"` : "base sensory: none",
    nextKey ? `next "${nextKey}"` : "next sensory: none",
    note1 && note2 ? `notes ${note1}+${note2}` : "note pair: none",
    `emotion codes ${[freqRow?.code, coreRow?.code].filter(Boolean).join("/") || "none"}`,
  ].join(" · ");

  const generatedOn = reportDate();
  const reportNo = await clientRoundNo(assessment);
  const overview = await fwmOverviewParagraphs(assessment, [...mha, ...ema], refreshOverview);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>EmoWave 5.0 — FWM Report — ${escapeHtml(assessment.customerId)}</title>
<style>
${REPORT_FONT_FACES}
  /* ---------------------------------------------------------------------
     Editorial treatment. The structure, the section order and every word
     are unchanged — this is presentation only. The previous version leaned
     on a gradient masthead and bordered cards; here the hierarchy is carried
     by type size, weight and rules, so the vendor copy reads as a document
     rather than as a stack of widgets.
     --------------------------------------------------------------------- */
  :root { --ink:#101019; --body:#2c2c39; --muted:#78788c; --line:#e3e3ea; --rule:#101019;
          --accent:#5b3fa8; --accent2:#b03270; }
  * { box-sizing:border-box; }
  /* 1.4 rather than 1.75: at 14.5px over a ~62ch measure, 1.75 left the lines
     of a paragraph reading as separate rows instead of one block of prose.
     Only the leading INSIDE a paragraph changes here — the gap BETWEEN
     paragraphs comes from <p>'s own 1em margin (nothing overrides it, see
     below), which is measured in font-size and so is unaffected by
     line-height. Tightening the lines therefore leaves the paragraph breaks
     exactly where they were, and makes them read as stronger breaks than
     before because the surrounding lines are now closer together.
     1.4 is about as tight as this measure takes — below it the eye starts
     losing its place returning to the start of the next line. */
  body { margin:0; font:14.5px/1.4 Roboto,"Segoe UI",sans-serif; color:var(--body); background:#fff;
         -webkit-font-smoothing:antialiased; }
  main { padding:0 64px 44px; }

  /* ---- Masthead: typographic, no colour band ---------------------------- */
  header { padding:110px 64px 46px; break-after:page; display:flex; flex-direction:column; min-height:930px; }
  header .eyebrow { font:600 10.5px Montserrat,sans-serif; letter-spacing:.22em; text-transform:uppercase;
                    color:var(--accent); }
  header h1 { font:700 44px/1.06 Montserrat,sans-serif; color:var(--ink); margin:24px 0 0; letter-spacing:-1.1px; }
  header .subject { font-size:16px; color:var(--muted); margin:18px 0 0; }
  header .meta { display:flex; gap:46px; margin:auto 0 0; padding-top:16px; border-top:2px solid var(--rule);
                 font-size:13.5px; color:var(--ink); }
  header .meta span { display:block; font:600 9.5px Montserrat,sans-serif; letter-spacing:.15em;
                      text-transform:uppercase; color:var(--muted); margin-bottom:5px; }

  /* ---- Opening overview: set as a lede, not a callout box --------------- */
  .fwm-summary { margin:24px 0 18px; }
  .fwm-summary h2 { display:block; font:700 25px/1.25 Montserrat,sans-serif; color:var(--ink); letter-spacing:-.5px;
                    text-transform:none; border:0; padding:0; margin:0 0 12px; }
  .fwm-summary p { margin:0 0 13px; } .fwm-summary p:last-of-type { margin-bottom:0; }
  .fwm-summary p { color:var(--ink); }

  /* ---- Profile at a glance: a ruled data strip -------------------------- */
  .fwm-profile { border-top:2px solid var(--rule); border-bottom:2px solid var(--rule); padding:0 0 8px; margin:0;
                  break-inside:avoid; }
  .fwm-profile h2 { display:block; font:600 10.5px Montserrat,sans-serif; letter-spacing:.18em; text-transform:uppercase;
                    color:var(--muted); border:0; padding:0; margin:9px 0 0; }
  table { width:100%; border-collapse:collapse; margin:8px 0 0; }
  tbody { display:grid; grid-template-columns:repeat(4,1fr); column-gap:26px; row-gap:10px; }
  tr { display:block; }
  td { display:block; border:0; padding:0; }
  td:first-child { color:var(--muted); font:600 9px Montserrat,sans-serif; letter-spacing:.11em;
                   text-transform:uppercase; width:auto; }
  td:last-child { color:var(--ink); font-size:12.5px; line-height:1.35; font-weight:500; margin-top:3px; }

  /* ---- Numbered sections: oversized numeral, tracked rule --------------- */
  h2 { display:flex; align-items:baseline; gap:16px; font:700 12.5px Montserrat,sans-serif; letter-spacing:.2em;
       text-transform:uppercase; color:var(--ink); margin:48px 0 0; padding:0 0 13px;
       border-bottom:2px solid var(--rule); break-after:avoid; break-inside:avoid; }
  h2 .num { display:block; width:auto; height:auto; margin:0; border-radius:0; background:none;
            color:var(--accent); font:700 31px Montserrat,sans-serif; letter-spacing:-1px; }
  .section-blurb { color:var(--muted); font-size:13px; margin:12px 0 0; max-width:62ch; break-after:avoid; }

  /* "Keep with next", which CSS has no real property for. break-after:avoid
     only binds a heading to whatever element follows — it will still happily
     leave a heading, its blurb and two clipped lines jammed against the bottom
     margin. Padding the heading unit out and pulling the following content
     back up by the same amount makes pagination measure a tall unbreakable
     block while nothing moves visually: if that much room isn't left on the
     page, the whole heading moves to the next one instead of starting a
     section no one can read. */
  section { break-before:page; }
  .section-head { break-inside:avoid; padding-bottom:150px; margin-bottom:-150px; }
  .group-head { break-inside:avoid; padding-bottom:70px; margin-bottom:-70px; }

  /* Groups deliberately DO break across pages; see .fwm-block--flow below. */
  .fwm-group { margin:34px 0 0; padding:0; border:0; }
  .fwm-group h3 { font:700 19px Montserrat,sans-serif; color:var(--ink); margin:0; letter-spacing:-.3px;
                  break-after:avoid; }
  .fwm-group-blurb { color:var(--muted); font-size:13px; margin:3px 0 0; break-after:avoid; }

  /* Blocks are rules, not boxes: a hairline and a tracked label. */
  .fwm-block { border:0; border-top:1px solid var(--line); border-radius:0; padding:15px 0 3px; margin:14px 0 0;
               break-inside:avoid; orphans:2; widows:2; }
  .fwm-block--flow { break-inside:auto; }
  .fwm-block h4 { margin:0 0 9px; font:600 14px Montserrat,sans-serif; color:var(--accent); letter-spacing:-.1px; }
  .fwm-block p { margin:0 0 10px; } .fwm-block p:last-of-type { margin-bottom:0; }
  .fwm-note { font-size:12.5px; color:var(--muted); font-style:italic; }
  .fwm-summary p, .fwm-block p { text-align:justify; hyphens:none; -webkit-hyphens:none; text-wrap:pretty; }

  .fwm-gap { border-top-style:dashed; border-top-color:var(--accent2); }
  .fwm-gap-msg { color:var(--accent2); font-weight:500; }
  .fwm-src { margin-top:12px; padding-top:9px; border-top:1px dashed var(--line);
             font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; color:var(--muted); }

  footer { margin:26px 64px 0; padding-top:14px; border-top:2px solid var(--rule); break-before:avoid;
           font-size:11.5px; line-height:1.65; color:var(--muted); }
  footer p { margin:0 0 8px; } footer p:last-child { margin-bottom:0; }

  @media print {
    /* Provenance badges and lookup keys are staff verification aids. */
    .fwm-src { display:none; }
    /* A gap is loud on screen on purpose — staff need to spot it. On paper the
       client gets a quiet line instead of a coloured warning. */
    .fwm-gap { border-top-style:solid; border-top-color:var(--line); }
    .fwm-gap-msg { color:var(--muted); font-weight:400; font-style:italic; }
  }
</style></head><body>
<header>
  <div class="eyebrow">EmoWave 5.0 · Emotional analytics</div>
  <h1>Financial Wealth Management</h1>
  <div class="subject">Prepared for ${escapeHtml(assessment.customerId)}</div>
  <div class="meta">
    <div><span>Date</span>${escapeHtml(generatedOn)}</div>
    <div><span>Report no.</span>${reportNo}</div>
  </div>
</header>
<main>
  <div class="fwm-summary">
    <h2>Analytic and Emotional Power for Financial Success</h2>
    ${
      overview
        ? overview.map((para) => `<p>${escapeHtml(para)}</p>`).join("") +
          `<div class="fwm-src">Composed by ${escapeHtml(PROSE_MODEL)} from every section below — the only generated copy in this report.</div>`
        // Generation is best-effort by design (see lib/fwmOverview.ts): a
        // model outage leaves the rest of the report — all of it vendor copy
        // — perfectly readable, so it prints without this section rather than
        // failing the download.
        : `<p>Overview unavailable for this report.</p>`
    }
  </div>

  <div class="fwm-profile">
    <h2>Your profile at a glance</h2>
    <table><tbody>
      ${profileRows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}
    </tbody></table>
    <div class="fwm-src">Lookup keys: ${escapeHtml(lookupKeys)}</div>
  </div>

  <section>
    <div class="section-head">
      <h2><span class="num">01</span>Mental Health Assessment (MHA)</h2>
      <p class="section-blurb">Identifying the psychological states that drive financial behavior.</p>
    </div>
    ${mha.map(groupHtml).join("")}
  </section>

  <section>
    <div class="section-head">
      <h2><span class="num">02</span>Emotional Analysis (EMA)</h2>
      <p class="section-blurb">Identifying and interpreting emotional patterns is vital for maintaining
      mental health during turbulent market cycles.</p>
    </div>
    ${ema.map(groupHtml).join("")}
  </section>
</main>
<footer>
  <p>This report describes emotional and behavioural patterns. It is not medical, psychological,
  financial, or legal advice, and should not be treated as a diagnosis or as a recommendation to
  buy, sell, or hold anything.</p>
  <p>Section order and nesting follow v1.0-Emowave-FWM Report.docx. Every section below the opening
  overview is read verbatim from the vendor's FWM reference tables; the opening overview is the one
  AI-composed part, written from those same sections. Sections the vendor's tables hold no row for
  are marked "Not included in this report."</p>
</footer>
</body></html>`;
}
