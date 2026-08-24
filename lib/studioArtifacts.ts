import { Type } from "@google/genai";
import { gemini, MODEL } from "./gemini";
import { prisma } from "./db";
import { loadAssessmentForAi, buildClientDataSummary } from "./clientData";
import { formatPrompt, lengthPrompt } from "./studioOptions";

/** What the Customise dialog collected, threaded through to the prompt. */
export type StudioOptions = { topic?: string; format?: string; length?: string };

/**
 * The Studio's five generated deliverables. All of them are Gemini
 * re-presentations of the SAME source text the Mind Map uses
 * (buildClientDataSummary — already-paraphrased content tables, raw facts as
 * fallback), so nothing here can introduce a claim the report itself doesn't
 * make. Each kind differs only in its output schema, its prompt, and how the
 * result is drawn; everything else (loading, caching, failure handling) is
 * shared below.
 */
export const STUDIO_KINDS = ["slide-deck", "flashcards", "quiz", "infographic", "data-table"] as const;
export type StudioKind = (typeof STUDIO_KINDS)[number];

export function isStudioKind(value: string): value is StudioKind {
  return (STUDIO_KINDS as readonly string[]).includes(value);
}

export type SlideDeck = { title: string; subtitle: string; slides: { title: string; bullets: string[]; notes: string }[] };
export type Flashcards = { title: string; cards: { front: string; back: string }[] };
export type Quiz = { title: string; questions: { question: string; options: string[]; answerIndex: number; explanation: string }[] };
export type Infographic = { title: string; subtitle: string; stats: { value: string; label: string }[]; sections: { heading: string; text: string }[] };
export type DataTable = { title: string; rows: { section: string; field: string; value: string }[] };

type KindSpec = { label: string; schema: object; prompt: (name: string) => string; valid: (data: any) => boolean };

// Kept as one object rather than a switch in each route, so adding a sixth
// deliverable is a single entry here plus a renderer below.
const SPECS: Record<StudioKind, KindSpec> = {
  "slide-deck": {
    label: "Slide Deck",
    schema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Deck title — the client's name and what this deck covers." },
        subtitle: { type: Type.STRING, description: "One short line under the title." },
        slides: {
          type: Type.ARRAY,
          description: "6-9 slides, one per theme in the source data.",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Slide heading (2-6 words)." },
              bullets: { type: Type.ARRAY, description: "3-5 short bullets.", items: { type: Type.STRING } },
              notes: { type: Type.STRING, description: "One or two sentences the presenter can say out loud." },
            },
            required: ["title", "bullets", "notes"],
          },
        },
      },
      required: ["title", "subtitle", "slides"],
    },
    prompt: (name) =>
      `Turn the following real assessment data about ${name} into a presentation deck a coach could walk them through: ` +
      "6-9 slides, each with a short heading, 3-5 bullets, and a presenter note.",
    valid: (d) => Array.isArray(d?.slides) && d.slides.length > 0,
  },

  flashcards: {
    label: "Flashcards",
    schema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Set title." },
        cards: {
          type: Type.ARRAY,
          description: "10-14 cards covering the whole profile.",
          items: {
            type: Type.OBJECT,
            properties: {
              front: { type: Type.STRING, description: "A prompt or question (one line)." },
              back: { type: Type.STRING, description: "The answer, grounded in the source data (1-2 sentences)." },
            },
            required: ["front", "back"],
          },
        },
      },
      required: ["title", "cards"],
    },
    prompt: (name) =>
      `Turn the following real assessment data about ${name} into 10-14 revision flashcards. Each front is a short ` +
      "prompt or question about this person's profile; each back answers it using only what the data says.",
    valid: (d) => Array.isArray(d?.cards) && d.cards.length > 0,
  },

  quiz: {
    label: "Quiz",
    schema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Quiz title." },
        questions: {
          type: Type.ARRAY,
          description: "6-10 multiple-choice questions.",
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              options: { type: Type.ARRAY, description: "Exactly 4 options.", items: { type: Type.STRING } },
              answerIndex: { type: Type.INTEGER, description: "0-based index of the correct option." },
              explanation: { type: Type.STRING, description: "One sentence on why that option is right." },
            },
            required: ["question", "options", "answerIndex", "explanation"],
          },
        },
      },
      required: ["title", "questions"],
    },
    prompt: (name) =>
      `Write a 6-10 question multiple-choice quiz that tests understanding of the following real assessment data about ` +
      `${name}. Exactly 4 options per question, only one correct, and the correct answer must be supported by the data ` +
      "below — the wrong options should be plausible but contradicted by it.",
    valid: (d) => Array.isArray(d?.questions) && d.questions.length > 0,
  },

  infographic: {
    label: "Infographic",
    schema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        subtitle: { type: Type.STRING, description: "One short line." },
        stats: {
          type: Type.ARRAY,
          description: "3-5 headline figures or one-word verdicts taken from the data (e.g. a stress level, a dominant emotion).",
          items: {
            type: Type.OBJECT,
            properties: {
              value: { type: Type.STRING, description: "Short — a number, level, or single word." },
              label: { type: Type.STRING, description: "What that figure is (2-4 words)." },
            },
            required: ["value", "label"],
          },
        },
        sections: {
          type: Type.ARRAY,
          description: "3-5 short blocks of supporting detail.",
          items: {
            type: Type.OBJECT,
            properties: {
              heading: { type: Type.STRING },
              text: { type: Type.STRING, description: "1-2 sentences." },
            },
            required: ["heading", "text"],
          },
        },
      },
      required: ["title", "subtitle", "stats", "sections"],
    },
    prompt: (name) =>
      `Lay the following real assessment data about ${name} out as an infographic: 3-5 headline figures (each a short ` +
      "value plus what it measures) and 3-5 short supporting blocks. Only use figures that actually appear in the data.",
    valid: (d) => Array.isArray(d?.stats) && d.stats.length > 0,
  },

  "data-table": {
    label: "Data Table",
    schema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        rows: {
          type: Type.ARRAY,
          description: "One row per data point, grouped by section.",
          items: {
            type: Type.OBJECT,
            properties: {
              section: { type: Type.STRING, description: "Which part of the report this came from (e.g. Stress, Emotional State)." },
              field: { type: Type.STRING, description: "What the value is (2-5 words)." },
              value: { type: Type.STRING, description: "The value itself, kept short." },
            },
            required: ["section", "field", "value"],
          },
        },
      },
      required: ["title", "rows"],
    },
    prompt: (name) =>
      `Flatten the following real assessment data about ${name} into a tidy reference table: one row per data point, ` +
      "each tagged with the section it came from. Keep values short — this is a lookup table, not prose. Copy values " +
      "as they appear; don't reinterpret them.",
    valid: (d) => Array.isArray(d?.rows) && d.rows.length > 0,
  },
};

export function studioLabel(kind: StudioKind): string {
  return SPECS[kind].label;
}

/**
 * Generates one artifact from a client's real data. Returns null — never a
 * fabricated stand-in — when the call fails or comes back malformed, the same
 * contract generateMindMap() uses, so a caller can tell "Gemini is down" from
 * "this client has no data".
 *
 * `topic` is the optional steer staff type into the Studio's generate dialog.
 * It narrows what the artifact covers; it deliberately does NOT relax the
 * grounding rule below, so asking for a topic the client's data doesn't
 * support yields less content rather than invented content.
 */
export async function generateStudioArtifact(
  kind: StudioKind,
  personName: string,
  sourceText: string,
  options: StudioOptions = {},
): Promise<object | null> {
  const spec = SPECS[kind];
  const { topic, format, length } = options;
  // Format and length come from the Customise dialog's own option list (see
  // lib/studioOptions.ts) — the dialog shows the label, this reads that same
  // entry's prompt fragment, so what staff picked is what the model is told.
  const steer = [
    formatPrompt(kind, format),
    lengthPrompt(length),
    topic?.trim()
      ? `Focus specifically on: ${topic.trim()}. Cover only what the data below actually supports about that — ` +
        "if it supports little, produce fewer items rather than padding with anything not evidenced there."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const prompt =
    `${spec.prompt(personName)}${steer ? `\n\n${steer}` : ""}\n\n` +
    "Every statement must be grounded in the data below — do not invent traits, numbers, or claims that aren't " +
    `there, and do not reproduce its sentences verbatim.\n\n${sourceText}`;

  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: spec.schema },
    });
    const text = response.text;
    const finish = response.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) {
      throw new Error(`${spec.label} generation did not complete cleanly (finishReason=${finish ?? "none"}).`);
    }
    const parsed = JSON.parse(text);
    return spec.valid(parsed) ? parsed : null;
  } catch (err) {
    console.error(`${spec.label} generation failed:`, err);
    return null;
  }
}

export type StudioResult =
  | { ok: true; kind: StudioKind; customerName: string; data: any; cached: boolean }
  | { ok: false; status: number; error: string };

/**
 * Cache-first load used by BOTH the JSON API and the standalone HTML page, so
 * the two can't disagree about what a client's deck/quiz says. `refresh`
 * forces a regeneration (new sources uploaded, or a bad first result).
 */
export async function loadOrGenerateArtifact(
  kind: StudioKind,
  assessmentId: bigint,
  refresh: boolean,
  options: StudioOptions = {},
): Promise<StudioResult> {
  const assessment = await loadAssessmentForAi(assessmentId);
  if (!assessment) return { ok: false, status: 404, error: `No assessment with id ${assessmentId}.` };

  // Any Customise choice is a request for a *different* artifact than the
  // cached one, so it always regenerates — otherwise the first version a
  // client ever got would be served forever regardless of what staff picked.
  const wantsFresh =
    refresh || Boolean(options.topic?.trim()) || Boolean(options.format) || (options.length ?? "default") !== "default";
  if (!wantsFresh) {
    const cached = await prisma.studioArtifact.findUnique({ where: { assessmentId_kind: { assessmentId, kind } } });
    if (cached) return { ok: true, kind, customerName: assessment.customerId, data: cached.data, cached: true };
  }

  const sourceText = buildClientDataSummary(assessment);
  if (!sourceText) {
    return { ok: false, status: 422, error: `This client has no processed content yet — upload a report first, then generate the ${SPECS[kind].label.toLowerCase()}.` };
  }

  const data = await generateStudioArtifact(kind, assessment.customerId, sourceText, options);
  if (!data) {
    return {
      ok: false,
      status: 502,
      error: `${SPECS[kind].label} generation failed — the Gemini API call did not succeed. Check the server log for the exact error (a 403 there means the API key is rejected).`,
    };
  }

  await prisma.studioArtifact.upsert({
    where: { assessmentId_kind: { assessmentId, kind } },
    create: { assessmentId, kind, data },
    update: { data },
  });

  return { ok: true, kind, customerName: assessment.customerId, data, cached: false };
}
