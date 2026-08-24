import { fact, type AssessmentWithFacts } from "./renderEwFullReport";

/**
 * A fast, non-rendering pass over the same data renderEwFullReportHtml
 * reads, listing which sections would come up empty — so a gap (like the
 * Blueprint chart having no data) is visible before opening the PDF, not
 * discovered by reading through the whole thing. Deliberately duplicates a
 * few of the renderer's own presence checks rather than refactoring it to
 * emit warnings itself — this only needs to be "probably right", the
 * renderer is the actual source of truth for what shows up.
 */
export function checkReportGaps(assessment: AssessmentWithFacts): string[] {
  const facts = assessment.facts;
  const warnings: string[] = [];

  const hasJourneyData = !!fact(facts, "Past Experiences - Code/Value");
  const hasNoteBalance = Array.isArray(assessment.journeyOverviewContent?.noteBalanceValues)
    ? (assessment.journeyOverviewContent!.noteBalanceValues as unknown as number[]).length === 12
    : false;
  if (!hasJourneyData && !hasNoteBalance) {
    warnings.push("Lifepath Blueprint / Journey Overview: no data — chart will render empty.");
  }

  const note1 = fact(facts, "Emotional State - Note 1") || fact(facts, "Public Self - note");
  const note2 = fact(facts, "Emotional State - Note 2") || fact(facts, "Private Self - note");
  if (!note1 && !note2) {
    warnings.push("Behaviour Pattern: no Note 1/Note 2 — wheel and note scale won't be marked for this client.");
  }

  const stressScore = fact(facts, "Stress Level - score");
  const stressIndex = fact(facts, "Stress index value");
  if (!stressScore && !stressIndex) {
    warnings.push("Stress | Choice: no stress score found.");
  }

  const presentCharacter = fact(facts, "Present Character") || fact(facts, "Sensory personality mode (Base)");
  if (!presentCharacter) {
    warnings.push("Present Character / Real Intention: no character data found.");
  }

  const hasAttributes = assessment.topAttributeContent.length > 0 || !!fact(facts, "Constructive Attribute 1");
  if (!hasAttributes) {
    warnings.push("Top 5 Constructive/Restrictive Attributes: no data found.");
  }

  // Deliberately NOT warned about: a missing client email. It only softens the
  // Journey Overview's axis labels (age brackets fall back to note names), so
  // the report is still complete without one — but most clients have no email
  // on file, which made this fire on nearly every preview and taught staff to
  // scroll past the whole warning box. The warnings above each mean a section
  // renders empty; keeping the list to those keeps it worth reading.

  return warnings;
}
