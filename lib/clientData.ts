import { prisma } from "./db";

function fact(facts: { label: string; value: unknown }[], label: string): string {
  const f = facts.find((x) => x.label === label);
  return f && typeof f.value === "string" ? f.value : "";
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

  const stress = assessment.stressContent?.description || fact(facts, "Stress Level - description");
  if (stress) lines.push(`Stress: ${stress}`);

  const es = assessment.emotionalStateContent;
  const note1 = es?.note1ReactionDesc || es?.publicSelfFull || fact(facts, "Public Self - full");
  const note2 = es?.note2ReactionDesc || es?.privateSelfFull || fact(facts, "Private Self - full");
  if (note1) lines.push(`Emotional State (primary): ${note1}`);
  if (note2) lines.push(`Emotional State (secondary): ${note2}`);
  if (es?.frequentEmotionDesc) lines.push(`Frequent Emotion: ${es.frequentEmotionDesc}`);
  if (es?.coreEmotionDesc) lines.push(`Core Emotion: ${es.coreEmotionDesc}`);

  const pc = assessment.presentCharacterContent;
  if (pc?.presentSummary) lines.push(`Present Character (${pc.presentTrait ?? ""}): ${pc.presentSummary}`);
  if (pc?.realSummary) lines.push(`Real Intention (${pc.realTrait ?? ""}): ${pc.realSummary}`);

  const dynamics = DYNAMIC_LABELS.map((l, i) => fact(facts, `Vortex Energy - Row ${i + 1}`)).filter(Boolean);
  if (dynamics.length > 0) lines.push(`Leadership Dynamics: ${dynamics.join("; ")}`);

  const constructive = assessment.topAttributeContent
    .filter((r) => r.kind === "constructive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.label} — ${r.description}`);
  if (constructive.length > 0) lines.push(`Constructive Attributes: ${constructive.join(" | ")}`);

  const restrictive = assessment.topAttributeContent
    .filter((r) => r.kind === "restrictive")
    .sort((a, b) => a.rank - b.rank)
    .map((r) => `${r.label} — ${r.description}`);
  if (restrictive.length > 0) lines.push(`Restrictive Attributes: ${restrictive.join(" | ")}`);

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
