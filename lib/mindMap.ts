import { Type } from "@google/genai";
import { gemini, MODEL } from "./gemini";

export type MindMapBranch = { label: string; children: string[] };
export type MindMapData = { root: string; branches: MindMapBranch[] };

const MIND_MAP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    root: { type: Type.STRING, description: "The central node — usually the person's name or a short theme like \"Emotional Profile\"." },
    branches: {
      type: Type.ARRAY,
      description: "4-7 main branches, each a category from the source data (e.g. Stress, Emotional State, Leadership, Attributes).",
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: "Short branch name (2-4 words)." },
          children: {
            type: Type.ARRAY,
            description: "2-5 short sub-points under this branch, each grounded in the source data below.",
            items: { type: Type.STRING },
          },
        },
        required: ["label", "children"],
      },
    },
  },
  required: ["root", "branches"],
};

/**
 * Turns a client's already-real report data into a mind map structure —
 * Gemini organizes/summarizes what's already there into a tree of short
 * labels, it doesn't invent new claims. Source text is whatever the caller
 * assembles from that assessment's facts/content (see buildMindMapSource()
 * in app/api/mind-map/[assessmentId]/route.ts) — same "grounded in real
 * data, safe fallback on failure" pattern as every other Gemini call in this
 * project. Returns null (never a fabricated map) if the call fails.
 */
export async function generateMindMap(personName: string, sourceText: string, topic?: string): Promise<MindMapData | null> {
  // Optional steer from the Studio's generate dialog. It narrows the map's
  // subject without loosening the grounding rule — a topic the data can't
  // support should yield a thinner map, not an invented one.
  const steer = topic?.trim()
    ? `Restrict the map to this topic: ${topic.trim()}. Use only what the data below actually says about it. `
    : "";
  const prompt =
    `Organize the following real data about ${personName} into a mind map: a central node and 4-7 branches, ` +
    "each with 2-5 short child points. " +
    steer +
    "Every branch and child must be grounded in the data below — don't invent " +
    "traits, numbers, or claims that aren't there. Keep labels short (a few words, not full sentences).\n\n" +
    sourceText;

  try {
    const response = await gemini.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json", responseSchema: MIND_MAP_SCHEMA },
    });
    const text = response.text;
    const finish = response.candidates?.[0]?.finishReason;
    if (!text || (finish && finish !== "STOP")) {
      throw new Error(`Mind map generation did not complete cleanly (finishReason=${finish ?? "none"}).`);
    }
    const parsed = JSON.parse(text) as Partial<MindMapData>;
    if (!parsed.root || !Array.isArray(parsed.branches) || parsed.branches.length === 0) return null;
    return { root: parsed.root, branches: parsed.branches as MindMapBranch[] };
  } catch (err) {
    console.error("Mind map generation failed:", err);
    return null;
  }
}
