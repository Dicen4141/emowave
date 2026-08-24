import { Type, type GenerateContentResponse } from "@google/genai";
import { gemini, MODEL } from "./gemini";
import type { Fact } from "./extractTemplateFacts";

// Visibility into actual Gemini cost per extraction — there was previously no
// way to know real token usage short of the Google Cloud Console. Logs after
// every call site below so per-upload totals are visible in the server log.
function logUsage(callName: string, response: GenerateContentResponse) {
  const u = response.usageMetadata;
  if (!u) return;
  console.log(
    `[gemini usage] ${callName}: prompt=${u.promptTokenCount ?? "?"} candidates=${u.candidatesTokenCount ?? "?"} total=${u.totalTokenCount ?? "?"}`,
  );
}

// Several extracted fields combine a short vendor-system code with a longer
// description in one string — "h1 - Hardworking, uncomplicated, with a clear
// overview." or "q1: Quiet." The code (their internal category ID) is a
// factual identifier, not creative writing, so it's kept as-is; only the
// description after it gets rewritten.
function splitCodePrefix(text: string): { prefix: string; body: string } {
  const m = /^(\S{1,6})\s*[-:]\s*(.+)$/s.exec(text);
  if (m && m[2].trim().length >= 15) return { prefix: `${m[1]} - `, body: m[2].trim() };
  return { prefix: "", body: text };
}

// Below this length a field is almost certainly a category label/code/number
// ("The Mediator (9)", "HEARING Inward Introvert") rather than prose worth
// rewriting — paraphrasing it would just be noise, or could even lose
// meaning on a short factual tag.
const PARAPHRASE_MIN_LENGTH = 35;

// Some fields hold machine-parsed structured data rather than prose — e.g.
// "<Category> - trait scores" is a newline-joined list of "NNN C/R - text"
// rows that downstream code re-parses line-by-line with an anchored regex
// (see traitCandidates() in renderEwFullReport.ts), and "Note Balance -
// values" is a fixed "NN. code=value" list matched with /=(\d+)/g. Handing
// either to Gemini for "fresh wording" collapses the newlines/format into a
// single flowing paragraph, which silently breaks that downstream parsing
// (observed: it left the Restrictive Attributes table completely empty).
// These are identifiers/numbers, not creative writing, so skip them.
function isStructuredField(label: string): boolean {
  return (
    /- trait scores$/.test(label) ||
    label === "Note Balance - values" ||
    label === "Sensory persona (Base)" ||
    label === "Sensory persona (Next)" ||
    label === "Sensory personality mode (Base)" ||
    label === "Sensory personality mode (Next)"
  );
}

async function paraphraseTexts(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  const schema = {
    type: Type.OBJECT,
    properties: {
      rewritten: {
        type: Type.ARRAY,
        description: `Exactly ${texts.length} rewritten strings, in the same order as the numbered input.`,
        items: { type: Type.STRING },
      },
    },
    required: ["rewritten"],
  };
  const prompt =
    `Rewrite each of the following ${texts.length} report snippets in fresh, original wording — ` +
    "keep the exact same meaning and facts, but use different sentences and vocabulary than the " +
    "source text. Keep each one roughly the same length. Do not add commentary or extra facts. " +
    `Return exactly ${texts.length} items, in the same order as given.\n\n` +
    texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

  const response = await gemini.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: schema },
  });
  logUsage("paraphraseTexts", response);

  const text = response.text;
  const finish = response.candidates?.[0]?.finishReason;
  if (!text || (finish && finish !== "STOP")) {
    throw new Error(`Paraphrase call did not complete cleanly (finishReason=${finish ?? "none"}).`);
  }
  const parsed = JSON.parse(text) as { rewritten?: unknown };
  const out = Array.isArray(parsed.rewritten) ? parsed.rewritten : [];
  // Fall back to the original sentence for any item the model dropped or
  // returned malformed, rather than losing content from the report.
  return texts.map((t, i) => (typeof out[i] === "string" && out[i].trim() ? out[i].trim() : t));
}

/**
 * Rewrites every prose-length fact value in original wording (via Gemini),
 * so the generated report doesn't reproduce the source vendor PDF's own
 * sentences verbatim. Short fields (codes, scores, single-word/category
 * labels) are left untouched — there's nothing to "copy" in a bare fact
 * like "C" or "2.10". Runs once at extraction time.
 *
 * Returns the two kinds of output SEPARATELY rather than merging them back
 * into one array: `raw` is every field completely untouched (what gets
 * saved to ReportFact — vendor-extracted text only, never AI-rewritten),
 * and `enhanced` is a label→text map of just the rewritten ones (what gets
 * saved to the section-specific "*Content" tables instead). If a rewrite
 * fails, that label still appears in `enhanced` using the original text —
 * still "AI-owned" content conceptually (the report shows this text as its
 * paraphrased slot), it just didn't get reworded this run.
 */
export async function paraphraseFacts(fields: Fact[]): Promise<{ raw: Fact[]; enhanced: Record<string, string> }> {
  const targets: { idx: number; prefix: string; body: string }[] = [];
  fields.forEach((f, idx) => {
    if (!f.text || isStructuredField(f.label)) return;
    const { prefix, body } = splitCodePrefix(f.text);
    if (body.length >= PARAPHRASE_MIN_LENGTH) targets.push({ idx, prefix, body });
  });
  if (targets.length === 0) return { raw: fields, enhanced: {} };

  let rewritten: string[] | null;
  try {
    rewritten = await paraphraseTexts(targets.map((t) => t.body));
  } catch (err) {
    // Paraphrasing is a best-effort polish step — if the model call fails,
    // fall back to the extracted text rather than losing the upload.
    console.error("Paraphrasing failed, keeping extracted text as-is:", err);
    rewritten = null;
  }

  const enhanced: Record<string, string> = {};
  targets.forEach((t, i) => {
    const body = rewritten ? rewritten[i] : fields[t.idx].text!;
    enhanced[fields[t.idx].label] = `${t.prefix}${body}`;
  });
  return { raw: fields, enhanced };
}

/**
 * Turns the bare "Introvert"/"Extrovert" persona word (Section 5's
 * Mind-Report fallback — see sensoryFallbackRow() in renderEwFullReport.ts)
 * into a short descriptive phrase in the reference report's own style
 * ("Universal Love", "Reliability, Responsibility to others") instead of
 * just the single word. Grounded in that same client's own surrounding
 * paragraph — not a generic Enneagram lookup table, which risks not
 * matching this vendor's specific wording — so it stays real per-client
 * data, just phrased more richly. Falls back to the bare word on failure.
 */
export async function generateTraitPhrase(word: string, context: string): Promise<string> {
  const schema = {
    type: Type.OBJECT,
    properties: {
      phrase: { type: Type.STRING, description: "A 2-5 word descriptive phrase, no trailing period." },
    },
    required: ["phrase"],
  };
  const prompt =
    `A person's sensory/personality profile is described as "${word}", based on this text:\n\n"${context}"\n\n` +
    'Write a short 2-5 word phrase capturing their core motivation or defining trait — in the style of "Universal Love" ' +
    'or "Reliability, Responsibility to others". Base it only on the text given, don\'t invent new facts about the person.';

  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: schema },
    });
    logUsage("generateTraitPhrase", response);
    const text = response.text;
    const finish = response.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) {
      throw new Error(`Trait phrase generation did not complete cleanly (finishReason=${finish ?? "none"}).`);
    }
    const parsed = JSON.parse(text) as { phrase?: string };
    return parsed.phrase && parsed.phrase.trim() ? parsed.phrase.trim() : word;
  } catch (err) {
    console.error("Trait phrase generation failed, falling back to the bare word:", err);
    return word;
  }
}

/**
 * Reads the "Note Balance" chart (Emotional Notes page 3) via Gemini
 * Vision — its per-note numbers are baked into image pixels with no OCR
 * available in this project, but only some of the 12 notes have an exact
 * number in the chart's own legend; the rest have to be read off the bar
 * heights the way a person would eyeball the chart. Used as the fallback
 * data source for the "Your Journey Overview" chart when there's no
 * iEmoWave-Full upload (whose own "Past Experiences" Code/Value table is
 * the primary source). Returns null — never a fabricated array — if the
 * call fails, so the section is omitted rather than showing invented data.
 */
export async function readNoteBalanceChart(imageDataUri: string): Promise<number[] | null> {
  const base64 = imageDataUri.replace(/^data:image\/\w+;base64,/, "");
  const schema = {
    type: Type.OBJECT,
    properties: {
      values: {
        type: Type.ARRAY,
        description: "Exactly 12 non-negative integers, one per note in order: C, C#, D, D#, E, F, F#, G, G#, A, A#, B.",
        items: { type: Type.INTEGER },
      },
    },
    required: ["values"],
  };
  const prompt =
    'This is a "Note Balance" mountain/area chart from a voice-analysis report, with 12 columns labeled C, C#, D, ' +
    "D#, E, F, F#, G, G#, A, A#, B in that order. A legend gives an exact number for some of the notes — read those " +
    "precisely and verbatim. For any note with no number in the legend, estimate its value from that bar's visual " +
    "height relative to the labeled bars, keeping the estimate consistent with the chart's overall shape. Return " +
    "exactly 12 integers, one per note, in the given order.";

  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "image/png", data: base64 } }, { text: prompt }],
        },
      ],
      config: { responseMimeType: "application/json", responseSchema: schema },
    });
    logUsage("readNoteBalanceChart", response);
    const text = response.text;
    const finish = response.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) {
      throw new Error(`Note Balance chart reading did not complete cleanly (finishReason=${finish ?? "none"}).`);
    }
    const parsed = JSON.parse(text) as { values?: unknown };
    const values = Array.isArray(parsed.values) ? parsed.values.map(Number) : [];
    if (values.length !== 12 || values.some((v) => !Number.isFinite(v))) return null;
    return values;
  } catch (err) {
    console.error("Note Balance chart reading failed:", err);
    return null;
  }
}
