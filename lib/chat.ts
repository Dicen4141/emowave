import { ApiError } from "@google/genai";
import { gemini, MODEL } from "./gemini";

export type ChatTurn = { role: "user" | "assistant"; text: string };

/**
 * Answers a question about one client. Claims ABOUT THE CLIENT stay
 * strictly grounded in their real report data — same "never fabricate" rule
 * as every other AI feature in this project. For questions that need
 * outside context (e.g. "find someone with a similar profile"), Google
 * Search grounding is enabled so the model can look something up for real
 * and cite where it came from, instead of the alternative: guessing a
 * plausible-sounding name from training data with no way to verify it,
 * which is exactly the kind of unverifiable claim this project avoids.
 * Kept as a single, isolated function (the only place that calls out to an
 * LLM for chat) so swapping Gemini for a different/self-hosted model later
 * is a one-function change, not a rewrite — per the plan to bring in a
 * custom LLM down the line.
 */
/**
 * The guardrails, with no data and no question attached — just the rules.
 *
 * Split out of answerClientQuestion (rather than copied) because it is
 * shipped to Quantemo as `payload.chat_prompt` alongside the knowledge base
 * (see lib/quantemoDelivery.ts), where a different model answers the same
 * questions for the end customer. One definition means the rules they run
 * under cannot silently drift from the rules used here: editing these
 * sentences changes both, and the next delivery carries the change.
 *
 * The three rules, in order below: ground every claim about the person in
 * the supplied data and admit the gaps; compare dated rounds directly when
 * asked how someone has changed; use outside knowledge only for context,
 * never to fill in a fact about the person.
 */
export function chatGuardrailPrompt(personName: string, opts: { canSearch?: boolean } = {}): string {
  // The one sentence that legitimately differs by model. EmoWave runs Gemini
  // with Google Search grounding on, so it is told to search; Quantemo's
  // local model may have no search at all, and telling it to "search the web"
  // would invite it to pretend it had. The RULE is identical either way —
  // outside knowledge is for context, never for a fact about the person.
  const outside = opts.canSearch
    ? "you may search the web for real, verifiable information — don't guess a name or fact from memory when a real search can confirm it."
    : "you may use general knowledge for that context only — never to fill in a fact about the person, and say when something is outside the data rather than guessing.";
  return (
    `You are answering questions about a person named ${personName}. For anything about ${personName} themselves — ` +
    `their traits, scores, or history — use ONLY the real report data provided; never invent details that aren't in it, ` +
    "and say so honestly if the data doesn't cover it. If the question needs outside information (e.g. comparing them " +
    `to a public figure, or general context), ${outside} Keep answers conversational and concise.\n\n` +
    "The data may contain more than one dated report for this person, each marked CURRENT or PREVIOUS and " +
    "labeled with its date — if there's more than one, and the question asks how they've changed, compare them " +
    "directly (what improved, worsened, or stayed the same) instead of only describing the current one. If only " +
    "one report is present, say plainly that there's nothing earlier to compare against rather than guessing.\n\n" +
    // Belt-and-braces for a failure this actually hit: the vendor's stress
    // text explains the scale with example figures, and a model with no real
    // score in front of it quoted one of those examples as the person's own.
    // buildClientDataSummary now always supplies the measured value on its own
    // labelled line, which is the real fix — this makes the mistake harder to
    // repeat if some future section is prose-only again.
    "Quote only this person's own measured values, which appear as their own labelled lines (e.g. " +
    '"Stress Level: 2.0"). Numbers that appear inside explanatory text — thresholds and examples such as ' +
    '"below 1%" or "5.5%" — describe how the scale works in general and are NEVER this person\'s score. ' +
    "If a value you're asked for has no labelled line, say it isn't in the data rather than taking a number from the explanation."
  );
}

export async function answerClientQuestion(personName: string, sourceText: string, question: string, history: ChatTurn[]): Promise<string> {
  const historyText = history.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n");
  const prompt =
    // canSearch: this call enables Google Search grounding below, so the
    // model is told to use it rather than guess from memory.
    chatGuardrailPrompt(personName, { canSearch: true }) +
    "\n\n" +
    `DATA ABOUT ${personName}:\n${sourceText}\n\n` +
    (historyText ? `CONVERSATION SO FAR:\n${historyText}\n\n` : "") +
    `New question: ${question}`;

  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    });
    const text = response.text;
    const finish = response.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) {
      throw new Error(`Chat answer did not complete cleanly (finishReason=${finish ?? "none"}).`);
    }
    // Surface real sources when search grounding actually fired, so a
    // claim like "similar to X" is checkable, not just asserted.
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const links = chunks
      .map((c) => c.web)
      .filter((w): w is { title?: string; uri?: string } => !!w?.uri)
      .slice(0, 5);
    const sourcesLine = links.length > 0 ? "\n\nSources: " + links.map((l) => `[${l.title || l.uri}](${l.uri})`).join(", ") : "";
    return text.trim() + sourcesLine;
  } catch (err) {
    console.error("Chat answer generation failed:", err);
    // Surfaced distinctly so it's obvious from the chat itself (not just
    // server logs) that this is a Gemini quota/rate-limit issue, not some
    // other failure — this was the single most common source of confusion
    // while diagnosing the free-tier rate limit during development.
    if (err instanceof ApiError && err.status === 429) {
      return "⚠ Gemini API rate limit reached (free tier: 15 requests/minute). Wait about a minute and try again, or check the project's billing status.";
    }
    return "Sorry, I couldn't process that question just now — please try again.";
  }
}
