import { Type } from "@google/genai";
import { gemini, PROSE_MODEL } from "./gemini";
import { prisma } from "./db";

/**
 * The FWM report's opening section, "Analytic and Emotional Power for
 * Financial Success".
 *
 * This is the ONE piece of generated prose in the FWM report. Every other
 * block is vendor copy read verbatim out of the fwm_* reference tables — the
 * vendor's own template (v1.0-Emowave-FWM Report.docx) marks this section, and
 * only this section, as AI-written, and specifies it as "composed from every
 * section below". So that is literally what it is given: the report's own
 * assembled blocks, not the raw facts. Grounding it in the finished copy means
 * the overview cannot state anything the pages under it don't already say.
 *
 * Cached per assessment, like MindMapContent and the Studio artifacts. The PDF
 * re-renders on every request (see the no-store header on /api/generate-report),
 * so generating live would add a model call to every download, and — worse —
 * hand a client different wording each time they reopen the same report.
 * `refresh` is the deliberate escape hatch for a bad first result.
 */

/** Structurally what renderFwmReport's Group is, minus the fields not needed here. */
export type OverviewSection = { title: string; blocks: { title: string; body: string }[] };

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    paragraphs: {
      type: Type.ARRAY,
      description:
        "3 or 4 paragraphs. The first states, analytically, what this client's profile means for how they " +
        "handle money. The middle one or two are narrative — a short, plausible account of how these exact " +
        "patterns show up in their ordinary financial life (a decision they face, how they meet it, what it " +
        "costs or wins them). The last looks forward, to what strengthening this would change for them.",
      items: { type: Type.STRING },
    },
  },
  required: ["paragraphs"],
};

/** The report's own blocks, flattened into the source text the model composes from. */
function sourceText(sections: OverviewSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    // Gap blocks (no matching reference row for this client) carry no copy —
    // feeding their empty titles in would invite the model to fill the hole.
    const filled = section.blocks.filter((b) => b.body.trim());
    if (filled.length === 0) continue;
    lines.push(`## ${section.title}`);
    for (const b of filled) lines.push(`${b.title}: ${b.body.trim()}`);
    lines.push("");
  }
  return lines.join("\n");
}

// Below this there is too little of the client's profile resolved to compose an
// overview that says anything — better the placeholder than four paragraphs
// spun out of two blocks.
const MIN_SECTIONS = 3;

async function generate(name: string, sections: OverviewSection[]): Promise<string[] | null> {
  const source = sourceText(sections);
  if (source.split("## ").length - 1 < MIN_SECTIONS) return null;

  const prompt =
    `Write the opening overview of a Financial Wealth Management report for ${name}, titled "Analytic and ` +
    `Emotional Power for Financial Success". It introduces the assessment below and is read before any of it.\n\n` +
    "Requirements:\n" +
    `- Address ${name} by name, in the same voice as the source text.\n` +
    "- Draw the through-line across the sections: name the pattern that connects their stress response, " +
    "character, emotional profile and decision-making, rather than restating each section in turn.\n" +
    "- Every statement must be grounded in the source below. Do not invent traits, scores, events, amounts " +
    "or dates, and do not reproduce its sentences verbatim.\n" +
    "- The narrative paragraphs are illustrative, not biography: keep them to situations the profile below " +
    "actually supports, and write them as how this pattern tends to play out, not as things that happened.\n" +
    "- This is a psychometric report, not financial advice. Never recommend an investment, product, or " +
    "course of action with money.\n" +
    "- Warm, plain, professional. No headings, no bullets, no markdown.\n\n" +
    `SOURCE — every section of ${name}'s report:\n\n${source}`;

  const response = await gemini.models.generateContent({
    model: PROSE_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: SCHEMA },
  });
  const u = response.usageMetadata;
  console.log(
    `[gemini usage] fwmOverview: prompt=${u?.promptTokenCount ?? "?"} candidates=${u?.candidatesTokenCount ?? "?"} total=${u?.totalTokenCount ?? "?"}`,
  );

  const finish = response.candidates?.[0]?.finishReason;
  if (!response.text || (finish && finish !== "STOP")) {
    throw new Error(`FWM overview did not complete cleanly (finishReason=${finish ?? "none"}).`);
  }
  const parsed = JSON.parse(response.text);
  const paragraphs: unknown = parsed?.paragraphs;
  if (!Array.isArray(paragraphs)) return null;
  const clean = paragraphs.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim());
  return clean.length > 0 ? clean : null;
}

/**
 * Cache-first. Returns null — never throws — when there is nothing to compose
 * from, when the model is unreachable, or when the table hasn't been pushed to
 * the database yet; the renderer falls back to its placeholder, so a Gemini
 * outage can never fail a report a client is waiting on.
 */
export async function fwmOverviewParagraphs(
  assessment: { id: bigint; customerId: string },
  sections: OverviewSection[],
  refresh = false,
): Promise<string[] | null> {
  try {
    if (!refresh) {
      const cached = await prisma.fwmOverviewContent.findUnique({ where: { assessmentId: assessment.id } });
      const stored = cached?.paragraphs;
      if (Array.isArray(stored) && stored.length > 0) return stored as string[];
    }

    const paragraphs = await generate(assessment.customerId, sections);
    if (!paragraphs) return null;

    await prisma.fwmOverviewContent.upsert({
      where: { assessmentId: assessment.id },
      update: { paragraphs, model: PROSE_MODEL },
      create: { assessmentId: assessment.id, paragraphs, model: PROSE_MODEL },
    });
    return paragraphs;
  } catch (err) {
    console.error("FWM overview generation failed:", err);
    return null;
  }
}
