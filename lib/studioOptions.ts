/**
 * What the Studio's "Customise" dialog offers for each tool, and the prompt
 * fragment each choice contributes.
 *
 * Deliberately free of any server import (no prisma, no gemini) so the client
 * component can import the labels from the same place the generator reads the
 * prompts — the dialog and the prompt can't drift apart the way they would if
 * the options were listed twice.
 */

export type StudioToolKind = "mind-map" | "slide-deck" | "flashcards" | "quiz" | "infographic" | "data-table";

export type StudioLength = "short" | "default" | "long";

export type FormatOption = {
  value: string;
  label: string;
  description: string;
  /** Appended to the generation prompt when this format is picked. */
  prompt: string;
};

export type StudioTool = {
  kind: StudioToolKind;
  label: string;
  /** Empty for tools whose output has only one sensible shape (Mind Map). */
  formats: FormatOption[];
  /** Mind Map has no length control — its size follows the data, not a preference. */
  hasLength: boolean;
  topicPlaceholder: string;
  /** One-click steers under the topic box, same idea as NotebookLM's chips. */
  suggestions: string[];
};

export const STUDIO_TOOLS: StudioTool[] = [
  {
    kind: "mind-map",
    label: "Mind Map",
    formats: [],
    hasLength: false,
    topicPlaceholder: "e.g. focus the map on how this client handles pressure at work",
    suggestions: ["Stress & pressure", "Communication style", "Leadership strengths"],
  },
  {
    kind: "slide-deck",
    label: "Slide Deck",
    formats: [
      {
        value: "detailed",
        label: "Detailed deck",
        description: "Full text on each slide — reads on its own, good for sending to the client.",
        prompt: "Write slides that stand alone when read without a presenter: fuller bullets, complete thoughts.",
      },
      {
        value: "presenter",
        label: "Presenter slides",
        description: "Short talking points on screen, the detail in the notes.",
        prompt: "Keep on-slide bullets to a few words each and put the substance in the presenter notes.",
      },
    ],
    hasLength: true,
    topicPlaceholder: "e.g. a coaching session on their restrictive attributes",
    suggestions: ["Coaching session", "Client debrief", "Strengths only"],
  },
  {
    kind: "flashcards",
    label: "Flashcards",
    formats: [
      {
        value: "recall",
        label: "Recall",
        description: "Straight question-and-answer over the profile's facts.",
        prompt: "Each front asks directly for a fact from the profile; each back states it.",
      },
      {
        value: "applied",
        label: "Applied",
        description: "Situational prompts — what this profile means in practice.",
        prompt: "Each front poses a real situation this person could face; each back answers using their profile.",
      },
    ],
    hasLength: true,
    topicPlaceholder: "e.g. only their emotional state and stress",
    suggestions: ["Emotional state", "Attributes", "Leadership dynamics"],
  },
  {
    kind: "quiz",
    label: "Quiz",
    formats: [
      {
        value: "check",
        label: "Knowledge check",
        description: "Clear questions with one obviously supported answer.",
        prompt: "Keep questions direct, with wrong options that are clearly not supported by the data.",
      },
      {
        value: "challenge",
        label: "Challenge",
        description: "Harder questions with closely-argued options.",
        prompt: "Make the wrong options genuinely tempting — close to the truth but contradicted by the data.",
      },
    ],
    hasLength: true,
    topicPlaceholder: "e.g. test understanding of their communication style",
    suggestions: ["Communication style", "Stress response", "Whole profile"],
  },
  {
    kind: "infographic",
    label: "Infographic",
    formats: [
      {
        value: "stats",
        label: "Stat-led",
        description: "Headline figures first, short supporting notes.",
        prompt: "Lead with the figures; keep every supporting block to one sentence.",
      },
      {
        value: "narrative",
        label: "Narrative",
        description: "Fewer figures, more explanation around them.",
        prompt: "Use fewer headline figures and give each supporting block two sentences of context.",
      },
    ],
    hasLength: true,
    topicPlaceholder: "e.g. a one-page summary for the client themselves",
    suggestions: ["Client-facing summary", "Strengths & risks", "Emotional profile"],
  },
  {
    kind: "data-table",
    label: "Data Table",
    formats: [
      {
        value: "full",
        label: "Full detail",
        description: "Every data point in the profile, one row each.",
        prompt: "Include every distinct data point available, even minor ones.",
      },
      {
        value: "summary",
        label: "Summary",
        description: "Only the headline values per section.",
        prompt: "Include only the most significant value or two per section.",
      },
    ],
    hasLength: false,
    topicPlaceholder: "e.g. only the attribute rows",
    suggestions: ["Attributes only", "Emotional data", "Everything"],
  },
];

export function studioTool(kind: string): StudioTool | undefined {
  return STUDIO_TOOLS.find((t) => t.kind === kind);
}

/** The prompt fragment for a chosen format, or "" for the default/unknown. */
export function formatPrompt(kind: string, value?: string): string {
  if (!value) return "";
  return studioTool(kind)?.formats.find((f) => f.value === value)?.prompt ?? "";
}

const LENGTH_PROMPTS: Record<StudioLength, string> = {
  short: "Keep it brief — the fewest items that still cover the ground, each one short.",
  default: "",
  long: "Go deeper — more items than usual, and more detail within each.",
};

export function lengthPrompt(value?: string): string {
  return LENGTH_PROMPTS[(value as StudioLength) ?? "default"] ?? "";
}
