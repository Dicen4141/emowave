import { prisma } from "./db";
import { loadClientHistoryForAi, buildClientHistorySummary } from "./clientData";
import { chatGuardrailPrompt } from "./chat";
import { buildFwmSummary } from "./fwmKnowledge";

// Wider than clientData's AI_INCLUDE, which covers the EmoWave report only.
// buildFwmGroups needs a full AssessmentWithFacts, and the extra relations are
// structurally compatible with AssessmentForAi, so one load serves both.
const KB_INCLUDE = {
  facts: true,
  stressContent: true,
  emotionalStateContent: true,
  sensoryAttributesContent: true,
  presentCharacterContent: true,
  topAttributeContent: true,
  wellnessChallengeContent: true,
  journeyOverviewContent: true,
} as const;

/**
 * The three `payload` keys Quantemo's report chat reads, exactly as they are
 * written into their reports row (see lib/quantemoDelivery.ts).
 *
 * Both content keys go null together and only together: chat_prompt present
 * therefore implies knowledge_base present, which is the invariant Quantemo
 * relies on to decide whether to enable the chat at all.
 */
export type DeliveryKnowledgeBase = {
  knowledge_base: string | null;
  chat_prompt: string | null;
  knowledge_base_generated_at: string | null;
};

export const EMPTY_KNOWLEDGE_BASE: DeliveryKnowledgeBase = {
  knowledge_base: null,
  chat_prompt: null,
  knowledge_base_generated_at: null,
};

/**
 * Builds the knowledge base a delivery carries: this round plus every other
 * round for the same client, each tagged CURRENT/PREVIOUS and dated.
 *
 * Shared by the delivery path and the read-only preview endpoint
 * (/api/knowledge-base) for the same reason chatGuardrailPrompt is shared —
 * a preview that came from a second code path would validate something other
 * than what actually ships.
 *
 * ORDER: oldest first, with CURRENT appended last
 * (loadClientHistoryForAi orders createdAt asc). Note that CURRENT means
 * "the round this delivery is for", NOT "the most recent" — delivering an
 * older round while a newer one exists puts a PREVIOUS block with a LATER
 * date ahead of it. The in-text dates are authoritative; position is not.
 *
 * canSearch is deliberately false: this prompt is for whatever model
 * Quantemo runs, which may have no web search. The rule is the same either
 * way — outside knowledge for context, never for a fact about the person.
 */
export async function buildDeliveryKnowledgeBase(assessmentId: bigint, slug?: string): Promise<DeliveryKnowledgeBase> {
  const forAi = await prisma.assessment.findUnique({ where: { id: assessmentId }, include: KB_INCLUDE });
  if (!forAi) return EMPTY_KNOWLEDGE_BASE;

  const priorRounds = await loadClientHistoryForAi(forAi.clientId, forAi.id);
  const emowave = buildClientHistorySummary(forAi, priorRounds);

  // VARIANT-SPECIFIC from here. Every variant used to receive an identical
  // copy, which meant a customer opening their Financial report and one
  // opening their EmoWave overview got the same answers to the same question —
  // and the chat could describe sections that aren't in the document in front
  // of them. Each row now carries the text for ITS OWN report.
  //
  // The Financial report gets the FWM sections. It also keeps the EmoWave
  // block, because its own "profile at a glance" prints the stress index,
  // character, notes and frequent/core emotion — a customer can read those on
  // page 2 and ask about them, so they have to be answerable here too.
  //
  // Everything else (overview / career / relationship / full) is EmoWave only:
  // those documents contain no financial content, and answering from sections
  // the reader cannot see is how the chat starts describing a report they
  // didn't buy.
  //
  // No slug means "everything" — the preview endpoint's default, so staff see
  // the full picture rather than one variant's slice.
  const wantsFwm = slug === undefined || slug === "fwm";
  let fwm = "";
  if (wantsFwm) {
    // Best-effort: six reference-table lookups, and a client whose combination
    // the workbook doesn't ship resolves to nothing. Neither is a reason to
    // ship no knowledge base at all.
    try {
      fwm = await buildFwmSummary(forAi);
    } catch (err) {
      console.error(`FWM knowledge for assessment ${assessmentId} could not be built; continuing without it:`, err);
    }
  }

  const text = fwm ? `${emowave}\n\n${fwm}` : emowave;
  // buildClientHistorySummary always returns the "--- CURRENT REPORT ---"
  // header even for a round with nothing in it, so a non-empty string is not
  // proof of content. Trimming to the header alone means there is nothing to
  // answer from, and shipping that would give Quantemo a chat with no data
  // rather than the "not ready" signal they act on.
  const hasContent = text.replace(/--- (CURRENT|PREVIOUS) REPORT \(\d{4}-\d{2}-\d{2}\) ---/g, "").trim().length > 0;
  if (!hasContent) return EMPTY_KNOWLEDGE_BASE;

  return {
    knowledge_base: text,
    chat_prompt: chatGuardrailPrompt(forAi.customerId, { canSearch: false }),
    knowledge_base_generated_at: new Date().toISOString(),
  };
}
