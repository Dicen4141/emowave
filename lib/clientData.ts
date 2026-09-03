import { prisma } from "./db";

function fact(facts: { label: string; value: unknown }[], label: string): string {
  const f = facts.find((x) => x.label === label);
  return f && typeof f.value === "string" ? f.value : "";
}

/**
 * Drops a leading vendor code from a headline value — "001: Quiet." becomes
 * "Quiet.", while a plain "Quiet." is returned untouched. Mirrors
 * splitCodeLabel() in renderEwFullReport, duplicated as three lines rather
 * than imported so this module stays free of the renderer (and its SVG
 * template and Puppeteer chain) for the sake of one regex.
 */
function codeLabel(combined: string): string {
  const m = /^(\S+):\s*(.*)$/.exec(combined);
  return m ? m[2] : combined;
}

const DYNAMIC_LABELS = [
  "1 - Purpose : Values, Passion, Purpose",
  "2 - Self Awareness : Insights to Beliefs",
  "3 - Self Development : Knowledge to Communicate",
  "4 - Self Management : Relationships to Love",
  "5 - Self Belief : Willpower to Wealth",
  "6 - Self Esteem : Belonging to Pleasure",
  "7 - Being : Experience to Foundation",
];

const AI_INCLUDE = {
  facts: true,
  stressContent: true,
  emotionalStateContent: true,
  presentCharacterContent: true,
  topAttributeContent: true,
} as const;

export function loadAssessmentForAi(id: bigint) {
  return prisma.assessment.findUnique({ where: { id }, include: AI_INCLUDE });
}

export type AssessmentForAi = NonNullable<Awaited<ReturnType<typeof loadAssessmentForAi>>>;

/**
 * Every OTHER round for the same client (repeat Quantemo purchases, or
 * manually re-uploaded reports), oldest first, so the chat can say "your
 * stress went from X to Y" instead of only ever seeing the one round it was
 * opened from. Only rounds that actually have facts count as real history —
 * an empty round waiting for its first upload has nothing to compare.
 * Returns [] for walk-in clients with no clientId (nothing to link against).
 */
export function loadClientHistoryForAi(clientId: bigint | null, excludeAssessmentId: bigint) {
  if (!clientId) return Promise.resolve([]);
  return prisma.assessment.findMany({
    where: { clientId, id: { not: excludeAssessmentId }, facts: { some: {} } },
    include: AI_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Pulls together the same real, already-Gemini-paraphrased data the report
 * itself uses (content tables first, raw facts as fallback — same priority
 * as renderEwFullReport.ts) into one plain-text block. This is the single
 * source of "what does the AI know about this client" for every AI feature
 * that needs to ground itself in real data — the mind map, chat, and
 * whatever gets added next (slide deck, quiz, etc.) all read from here
 * instead of each re-deriving their own summary.
 */
export function buildClientDataSummary(assessment: AssessmentForAi): string {
  const facts = assessment.facts;
  const lines: string[] = [];

  // HEADLINE VALUES FIRST, EACH LABELLED. These are the numbers printed on
  // the front of the report, and until they were added here the summary
  // carried only the prose around them — which made every question about a
  // real score unanswerable, and worse than unanswerable: the vendor's stress
  // blurb explains the scale using example figures ("a score below 1%… while
  // 5.5% suggests…"), so a model asked "what's my stress level?" had no real
  // number to find and confidently returned 5.5% — the example — for a person
  // whose actual score was 2.0.
  //
  // Rule for anything added here: if a value is shown on the report, it must
  // appear in this text as a labelled value, not only inside prose.

  // Same source order and the same ".0" formatting renderOverviewSvg uses, so
  // the chat quotes the exact figure the customer is reading on their PDF —
  // a chat that says "2" against a report that says "2.0" is a support ticket.
  const stressNum = fact(facts, "Stress Level - score") || fact(facts, "Stress index value");
  // The type name lives in the fact's LABEL, e.g. "Stress type (Logical stress)".
  const stressTypeFact = facts.find((f) => f.label.startsWith("Stress type (") && typeof f.value === "string");
  const stressCategory = stressTypeFact ? stressTypeFact.label.replace(/^Stress type \(|\)$/g, "") : "";
  if (stressNum) {
    const shown = /^\d+$/.test(stressNum) ? `${stressNum}.0` : stressNum;
    lines.push(`Stress Level: ${shown}${stressCategory ? ` (${stressCategory})` : ""}`);
  }

  const stress = assessment.stressContent?.description || fact(facts, "Stress Level - description") || stressTypeFact?.value;
  // The explanatory blurb ships ONLY when the real value shipped above it.
  // On its own it is actively harmful: it is a page of threshold examples
  // with no true figure to anchor them, which is precisely what produced the
  // wrong answer. No number, no blurb.
  if (stress && stressNum && typeof stress === "string") lines.push(`Stress explanation: ${stress}`);

  // Printed on the report as "L: 987  R: 452"; stored as one "L=987, R=452"
  // string. Passed through as-is rather than parsed — the labels are already
  // unambiguous and re-formatting risks disagreeing with the PDF.
  const lrBrain = fact(facts, "L/R Brain - values");
  if (lrBrain) lines.push(`Brain Activity (left/right): ${lrBrain}`);

  // The two musical notes the whole Behaviour Pattern section is keyed to,
  // and the headline the report marks on its note scale. Same fallback order
  // renderEwFullReport and reportGapCheck use.
  const noteName1 = fact(facts, "Emotional State - Note 1") || fact(facts, "Public Self - note");
  const noteName2 = fact(facts, "Emotional State - Note 2") || fact(facts, "Private Self - note");
  if (noteName1) lines.push(`Behaviour Note 1 (public self): ${noteName1}`);
  if (noteName2) lines.push(`Behaviour Note 2 (private self): ${noteName2}`);

  const es = assessment.emotionalStateContent;
  const note1 = es?.note1ReactionDesc || es?.publicSelfFull || fact(facts, "Public Self - full");
  const note2 = es?.note2ReactionDesc || es?.privateSelfFull || fact(facts, "Private Self - full");
  if (note1) lines.push(`Emotional State (primary): ${note1}`);
  if (note2) lines.push(`Emotional State (secondary): ${note2}`);
  // Same rule as the stress score: the bold word the report prints gets its
  // own labelled line, ahead of the prose.
  //
  // These two are the case that proves the rule. "Quiet." and "Diligent." are
  // what the Emotional Pattern panel prints, and without them the summary
  // carried only the two descriptions — which both happen to mention
  // diligence and conscientiousness. Asked to compare them, the chat answered
  // that Frequent and Core were "the same", directly contradicting the
  // report the customer was holding. The labels are what make them distinct.
  const freqLabel = codeLabel(fact(facts, "Frequent Emotion (Mind Report)") || fact(facts, "Frequent Emotion"));
  const coreLabel = codeLabel(fact(facts, "Core Emotion (Mind Report)") || fact(facts, "Core Emotion"));
  const freqDesc = es?.frequentEmotionDesc || fact(facts, "Frequent Emotion (Mind Report) - description");
  const coreDesc = es?.coreEmotionDesc || fact(facts, "Core Emotion (Mind Report) - description");
  if (freqLabel) lines.push(`Frequent Emotion: ${freqLabel}`);
  if (freqDesc) lines.push(`Frequent Emotion explanation: ${freqDesc}`);
  if (coreLabel) lines.push(`Core Emotion: ${coreLabel}`);
  if (coreDesc) lines.push(`Core Emotion explanation: ${coreDesc}`);

  const pc = assessment.presentCharacterContent;
  // The character NAME ("The Mediator (9)") is what the report puts in its
  // chips; presentTrait/realTrait are the descriptive phrases beside it.
  // Both go in — the name is what a customer reading their report will ask
  // about by name, and it was previously nowhere in the text.
  const presentName = fact(facts, "Sensory personality mode (Base)") || fact(facts, "Present Character");
  const realName = fact(facts, "Sensory personality mode (Next)") || fact(facts, "Real Intention");
  if (presentName) lines.push(`Present Character: ${presentName}`);
  if (pc?.presentSummary) lines.push(`Present Character (${pc.presentTrait ?? ""}): ${pc.presentSummary}`);
  if (realName) lines.push(`Real Intention: ${realName}`);
  if (pc?.realSummary) lines.push(`Real Intention (${pc.realTrait ?? ""}): ${pc.realSummary}`);

  const dynamics = DYNAMIC_LABELS.map((l, i) => fact(facts, `Vortex Energy - Row ${i + 1}`)).filter(Boolean);
  if (dynamics.length > 0) lines.push(`Leadership Dynamics: ${dynamics.join("; ")}`);

  const constructive = assessment.topAttributeContent
    .filter((r) => r.kind === "constructive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.label} — ${r.description}`);
  // Labelled with the report's OWN wording ("top 5: empowering") as well as
  // the internal one. A customer asks using the heading printed on their page,
  // and asking for "top 5 empowering" against a line labelled only
  // "Constructive Attributes" returned "unable to find" — the data was right
  // there under a name they had never seen.
  if (constructive.length > 0) lines.push(`Top 5 Empowering Attributes (constructive): ${constructive.join(" | ")}`);

  const restrictive = assessment.topAttributeContent
    .filter((r) => r.kind === "restrictive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.label} — ${r.description}`);
  if (restrictive.length > 0) lines.push(`Top 5 Dis-empowering Attributes (restrictive): ${restrictive.join(" | ")}`);

  return lines.join("\n");
}

/**
 * Combines the round currently open in the chat with every prior round for
 * the same client into one labeled block, oldest first, so a question like
 * "how does this compare to my last report" has actual prior data to compare
 * against instead of the model having to say it doesn't have any. Each round
 * is dated and marked (CURRENT) or (PREVIOUS) rather than left for the model
 * to infer order from — getting "before/after" backwards would misreport
 * real progress (e.g. stress going up read as going down).
 */
export function buildClientHistorySummary(current: AssessmentForAi, history: AssessmentForAi[]): string {
  const dateOf = (a: AssessmentForAi) => a.createdAt.toISOString().slice(0, 10);
  const rounds = [...history.map((a) => ({ a, tag: "PREVIOUS" })), { a: current, tag: "CURRENT" }];
  return rounds
    .map(({ a, tag }) => `--- ${tag} REPORT (${dateOf(a)}) ---\n${buildClientDataSummary(a)}`)
    .join("\n\n");
}

/** Which raw report sources actually exist for this client — the Sources panel's list. */
export function listSources(assessment: AssessmentForAi): { sourceReport: string; fieldCount: number }[] {
  const counts = new Map<string, number>();
  for (const f of assessment.facts) {
    counts.set(f.sourceReport, (counts.get(f.sourceReport) ?? 0) + 1);
  }
  return [...counts.entries()].map(([sourceReport, fieldCount]) => ({ sourceReport, fieldCount }));
}
