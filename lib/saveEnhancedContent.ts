import { prisma } from "./db";
import type { Fact } from "./extractTemplateFacts";

// Present Character/Real Intention and Frequent/Core Emotion each have TWO
// possible source labels — the iEmoWave-Full page's own field, or the Mind
// Report fallback's differently-named equivalent — but only one of a pair
// is ever present for a given client, so both map onto the same column.
function firstOf(enhanced: Record<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    if (enhanced[label] !== undefined) return enhanced[label];
  }
  return undefined;
}

/**
 * Saves everything Gemini generated or rewrote for one extraction pass into
 * the section-specific "*Content" tables — the counterpart to saving
 * `result.fields` (untouched vendor text) into ReportFact. Called once per
 * PDF upload, right after that upload's raw fields are saved. Uses `update`
 * objects with only the columns this batch actually touched (Prisma skips
 * `undefined` keys on update) so uploading, say, just a Mind Report doesn't
 * blank out iEmoWave-Full content saved from an earlier upload of the same
 * assessment, or vice versa.
 */
export async function saveEnhancedContent(assessmentId: bigint, enhanced: Record<string, string>, rawFields: Fact[]): Promise<void> {
  const rawLabel = (label: string) => rawFields.find((f) => f.label === label)?.text ?? "";

  // iEmoWave-Full uses the static "Stress Level - description" label; the
  // Mind Report fallback stores the same kind of text under a dynamic
  // "Stress type (<Their Stress Type>)" label instead (the type name varies
  // per client, e.g. "Stress type (Logical stress)").
  const stressDesc = enhanced["Stress Level - description"] ?? Object.entries(enhanced).find(([label]) => /^Stress type \(/.test(label))?.[1];
  if (stressDesc !== undefined) {
    await prisma.stressContent.upsert({
      where: { assessmentId },
      create: { assessmentId, description: stressDesc },
      update: { description: stressDesc },
    });
  }

  const emotionalState = {
    note1ReactionDesc: enhanced["Emotional State - Note 1 reaction"],
    note2ReactionDesc: enhanced["Emotional State - Note 2 reaction"],
    publicSelfFull: enhanced["Public Self - full"],
    privateSelfFull: enhanced["Private Self - full"],
    frequentEmotionDesc: firstOf(enhanced, ["Frequent Emotion - description", "Frequent Emotion (Mind Report) - description"]),
    coreEmotionDesc: firstOf(enhanced, ["Core Emotion - description", "Core Emotion (Mind Report) - description"]),
    empoweringDesc: enhanced["Empowering Emotion"],
    disempoweringDesc: enhanced["Dis-empowering Emotion"],
  };
  if (Object.values(emotionalState).some((v) => v !== undefined)) {
    await prisma.emotionalStateContent.upsert({
      where: { assessmentId },
      create: { assessmentId, ...emotionalState },
      update: emotionalState,
    });
  }

  const sensoryAttrs = {
    baseDesc: enhanced["Sensory Attributes - BASE"],
    nextDesc: enhanced["Sensory Attributes - NEXT"],
  };
  if (sensoryAttrs.baseDesc !== undefined || sensoryAttrs.nextDesc !== undefined) {
    await prisma.sensoryAttributesContent.upsert({
      where: { assessmentId },
      create: { assessmentId, ...sensoryAttrs },
      update: sensoryAttrs,
    });
  }

  const presentCharacter = {
    presentTrait: firstOf(enhanced, ["Present Character - trait", "Sensory persona (Base)"]),
    presentSummary: firstOf(enhanced, ["Present Character - summary", "Sensory - first type (Base)"]),
    realTrait: firstOf(enhanced, ["Real Intention - trait", "Sensory persona (Next)"]),
    realSummary: firstOf(enhanced, ["Real Intention - summary", "Sensory - second type (Next)"]),
  };
  if (Object.values(presentCharacter).some((v) => v !== undefined)) {
    await prisma.presentCharacterContent.upsert({
      where: { assessmentId },
      create: { assessmentId, ...presentCharacter },
      update: presentCharacter,
    });
  }

  const noteBalanceRaw = enhanced["Note Balance - values"];
  if (noteBalanceRaw !== undefined) {
    const values = [...noteBalanceRaw.matchAll(/=(\d+)/g)].map((m) => Number(m[1]));
    if (values.length === 12) {
      await prisma.journeyOverviewContent.upsert({
        where: { assessmentId },
        create: { assessmentId, noteBalanceValues: values },
        update: { noteBalanceValues: values },
      });
    }
  }

  // iEmoWave-Full's own Top 5 Constructive/Restrictive Attributes — replace
  // this assessment's rows wholesale (this upload is always the complete
  // set of up to 5+5, never a partial update).
  const attrRows: { kind: string; rank: number; label: string; description: string }[] = [];
  for (const [label, description] of Object.entries(enhanced)) {
    const m = /^(Constructive|Restrictive) Attribute (\d+) - description$/.exec(label);
    if (!m) continue;
    const kind = m[1] === "Constructive" ? "constructive" : "restrictive";
    const rowLabel = rawLabel(`${m[1]} Attribute ${m[2]}`);
    if (rowLabel) attrRows.push({ kind, rank: Number(m[2]), label: rowLabel, description });
  }
  if (attrRows.length > 0) {
    await prisma.$transaction([
      prisma.topAttributeContent.deleteMany({ where: { assessmentId, kind: { in: [...new Set(attrRows.map((r) => r.kind))] } } }),
      prisma.topAttributeContent.createMany({ data: attrRows.map((r) => ({ assessmentId, ...r })) }),
    ]);
  }

  // iEmoWave-Full's Wellness Challenge — same wholesale-replace approach.
  const wellnessRows: { rank: number; label: string; description: string }[] = [];
  for (const [label, description] of Object.entries(enhanced)) {
    const m = /^Wellness Challenge (\d+) - description$/.exec(label);
    if (!m) continue;
    const rowLabel = rawLabel(`Wellness Challenge ${m[1]}`);
    if (rowLabel) wellnessRows.push({ rank: Number(m[1]), label: rowLabel, description });
  }
  if (wellnessRows.length > 0) {
    await prisma.$transaction([
      prisma.wellnessChallengeContent.deleteMany({ where: { assessmentId } }),
      prisma.wellnessChallengeContent.createMany({ data: wellnessRows.map((r) => ({ assessmentId, ...r })) }),
    ]);
  }
}

const EMOTIONAL_NOTES_CATEGORIES = ["Personality", "Mirrored Perception", "Emotional", "Impulsive", "Rational", "Social"];

/**
 * Recomputes the Emotional-Notes-derived Top 5 Constructive/Restrictive
 * fallback and stores it, so report generation is a plain read instead of
 * calling Gemini on every view (which is what this replaces — the fallback
 * used to run live inside renderEwFullReportHtml()). Call this after any
 * upload that could change the inputs (a fresh Emotional Notes upload, or
 * an iEmoWave-Full upload/removal that changes whether the fallback is even
 * used). No-ops when this assessment has real iEmoWave-Full attribute data
 * (that always takes priority) or no trait-score categories yet.
 */
export async function refreshFallbackTopAttributes(assessmentId: bigint): Promise<void> {
  // Only iEmoWave-Full's own real attribute data should block the
  // fallback — NOT the mere presence of existing TopAttributeContent rows,
  // which could just be this same fallback's own output from a previous
  // run (and must still be recomputed, e.g. after a fresh Emotional Notes
  // upload changes the inputs).
  const ewFullSourced = await prisma.reportFact.findFirst({ where: { assessmentId, label: "Constructive Attribute 1" } });
  if (ewFullSourced) return;

  const facts = await prisma.reportFact.findMany({ where: { assessmentId } });
  // "count" here is how many of the 6 category pages list this exact phrase
  // at all — NOT the vendor's own printed number next to each line (that
  // number is ignored entirely, per instruction: rank by how often the
  // phrase itself recurs across Personality through Social, not by what's
  // printed in front of it).
  const traitCandidates = (type: "C" | "R", limit: number): { text: string; category: string; count: number }[] => {
    const byText = new Map<string, { text: string; category: string; count: number }>();
    for (const category of EMOTIONAL_NOTES_CATEGORIES) {
      const raw = facts.find((f) => f.label === `${category} - trait scores`)?.value;
      if (typeof raw !== "string") continue;
      const re = new RegExp(`^\\d+\\s+${type}\\s*-\\s*(.+)$`);
      for (const line of raw.split("\n")) {
        const m = re.exec(line.trim());
        if (!m) continue;
        const text = m[1];
        const existing = byText.get(text);
        if (existing) existing.count += 1;
        else byText.set(text, { text, category, count: 1 });
      }
    }
    return [...byText.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  };

  // Straight top-5 by occurrence count, no AI picking or rewriting — Gemini
  // used to choose "the 5 most distinct" and write its own explanation
  // sentence, but that meant the actual highest-count trait could get
  // silently dropped in favor of much rarer ones (confirmed: a count-17
  // trait excluded in favor of several count-1 ones), and the written
  // "description" was an invented sentence, not real data. This is fully
  // deterministic and every word shown is the vendor's own extracted text.
  const cCandidates = traitCandidates("C", 5);
  const rCandidates = traitCandidates("R", 5);
  if (cCandidates.length === 0 && rCandidates.length === 0) return;

  const rows = [
    ...cCandidates.map((c, i) => ({ assessmentId, kind: "constructive", rank: i + 1, label: c.text, description: c.text })),
    ...rCandidates.map((r, i) => ({ assessmentId, kind: "restrictive", rank: i + 1, label: r.text, description: r.text })),
  ];
  if (rows.length === 0) return;

  await prisma.$transaction([
    prisma.topAttributeContent.deleteMany({ where: { assessmentId } }),
    prisma.topAttributeContent.createMany({ data: rows }),
  ]);
}
