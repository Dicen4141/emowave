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
export async function answerClientQuestion(personName: string, sourceText: string, question: string, history: ChatTurn[]): Promise<string> {
  const historyText = history.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n");
  const prompt =
    `You are answering questions about a person named ${personName}. For anything about ${personName} themselves — ` +
    `their traits, scores, or history — use ONLY the real report data below; never invent details that aren't in it, ` +
    "and say so honestly if the data doesn't cover it. If the question needs outside information (e.g. comparing them " +
    "to a public figure, or general context), you may search the web for real, verifiable information — don't guess " +
    "a name or fact from memory when a real search can confirm it. Keep answers conversational and concise.\n\n" +
    "The data below may contain more than one dated report for this person, each marked CURRENT or PREVIOUS and " +
    "labeled with its date — if there's more than one, and the question asks how they've changed, compare them " +
    "directly (what improved, worsened, or stayed the same) instead of only describing the current one. If only " +
    "one report is present, say plainly that there's nothing earlier to compare against rather than guessing.\n\n" +
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
