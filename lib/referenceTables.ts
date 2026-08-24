// Config for the vendor lookup tables (Data-*.xlsx and the FWM workbooks — see the
// comments above each model in prisma/schema.prisma) that used to only be
// editable straight from the Supabase table editor. Adding a 6th table later
// (e.g. the still-unimported "Data-Communication...") means adding one entry
// here plus one case in the matching switch in app/api/reference-data/[table]/route.ts
// — nothing else needs to change, the admin page renders from this config.
//
// No Prisma import here on purpose — this file is also imported by the
// client-side admin page, and Prisma Client isn't safe to bundle into the
// browser.
export type FieldType = "text" | "textarea" | "int" | "float";

export type ReferenceField = {
  key: string; // matches the Prisma model's field name
  label: string;
  type: FieldType;
  required?: boolean;
  // Part of the row's identity — shown read-only on existing rows (editing
  // an id would silently orphan it from whatever report code looks it up).
  isId?: boolean;
  // Database-assigned (autoincrement) — displayed, but never sent on create
  // and never part of an update's payload.
  autoAssigned?: boolean;
};

export type ReferenceTableConfig = {
  key: string; // URL-safe slug, used in /api/reference-data/[table]
  label: string;
  sourceFile: string; // the vendor spreadsheet this mirrors, shown as a hint
  fields: ReferenceField[];
};

export const REFERENCE_TABLES: ReferenceTableConfig[] = [
  {
    key: "note-behavior",
    label: "Behaviour Pattern",
    sourceFile: "Data-Behaviour Pattern.xlsx",
    fields: [
      { key: "note", label: "Note", type: "text", isId: true, required: true },
      { key: "musicNote", label: "Music Note", type: "text" },
      { key: "generalReaction", label: "General Reaction", type: "textarea", required: true },
      { key: "empowering", label: "Empowering", type: "text" },
      { key: "disempowering", label: "Disempowering", type: "text" },
      { key: "socialBehaviorPattern", label: "Social Behavior Pattern", type: "textarea" },
      { key: "positiveEmotionDesc", label: "Positive Emotion Desc", type: "textarea" },
      { key: "negativeEmotionDesc", label: "Negative Emotion Desc", type: "textarea" },
      { key: "childrenReaction", label: "Children Reaction", type: "textarea" },
    ],
  },
  {
    key: "character",
    label: "Present & Real Intention Characters",
    sourceFile: "Data-Present and Real Intention Characters.xlsx",
    fields: [
      { key: "language", label: "Language", type: "text", isId: true, required: true },
      { key: "number", label: "Number", type: "int", isId: true, required: true },
      { key: "character", label: "Character", type: "text", required: true },
      { key: "presentCharacter", label: "Present Character (short trait)", type: "text" },
      { key: "summary", label: "Summary", type: "textarea" },
      { key: "workEnvironment", label: "Work Environment", type: "textarea" },
      { key: "ideasJobs", label: "Ideas / Jobs", type: "textarea" },
      { key: "growPath", label: "Grow Path", type: "textarea" },
    ],
  },
  {
    key: "emotion-code",
    label: "Frequent & Core Emotion",
    sourceFile: "Data-Frequent and Core Emotional Pattern.xlsx",
    fields: [
      { key: "code", label: "Code", type: "text", isId: true, required: true },
      { key: "header", label: "Header", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "explanation", label: "Explanation", type: "textarea" },
    ],
  },
  {
    key: "attribute-code",
    label: "Empower & Disempower",
    sourceFile: "Data-Empower and Disempower.xlsx",
    fields: [
      { key: "code", label: "Code", type: "text", isId: true, required: true },
      { key: "header", label: "Header", type: "textarea" }, // real data: full sentences, not a short label despite the name
      { key: "description", label: "Description", type: "textarea" },
    ],
  },
  {
    key: "stress-range",
    label: "Stress",
    sourceFile: "Data-Stress.xlsx",
    fields: [
      { key: "id", label: "ID", type: "int", isId: true, autoAssigned: true },
      { key: "stressFrom", label: "Stress From", type: "float", required: true },
      { key: "stressTo", label: "Stress To", type: "float", required: true },
      { key: "descriptionEn", label: "Description (EN)", type: "textarea" },
      { key: "indicator", label: "Indicator", type: "textarea" },
      { key: "childrenIntelligence", label: "Children Intelligence", type: "textarea" },
    ],
  },

  // ---------------------------------------------------------------------
  // Financial Wealth Management (FWM). Seven tables behind the FWM report
  // (lib/renderFwmReport.ts), imported by scripts/import-fwm-reference-data.mjs.
  // Frequent/Core Emotions and Musical Notes are absent on purpose: the FWM
  // workbooks' versions of those two sheets are identical to "Frequent & Core
  // Emotion" and "Behaviour Pattern" above, so that report reads those rather
  // than a second copy.
  //
  // Editing any of these changes the FWM report for every client, and a
  // re-run of the import script overwrites the edit — same trade-off the
  // Stress table above already carries.
  // ---------------------------------------------------------------------
  {
    key: "fwm-stress-range",
    label: "FWM — Stress & Financial Intelligence",
    sourceFile: "v1.0- DataStress_FWM.xlsx (All_Stress_Types)",
    fields: [
      { key: "id", label: "ID", type: "int", isId: true, autoAssigned: true },
      { key: "stressFrom", label: "Stress From", type: "float", required: true },
      { key: "stressTo", label: "Stress To", type: "float", required: true },
      { key: "general", label: "General", type: "textarea" },
      { key: "indicator", label: "Indicator", type: "textarea" },
      { key: "financialIntelligence", label: "Financial Intelligence", type: "textarea" },
      { key: "childrenIntelligence", label: "Children Intelligence", type: "textarea" },
    ],
  },
  {
    key: "fwm-present-character",
    label: "FWM — Present Characters",
    sourceFile: "v1.0_Characteristics_FWM_DataSet.xlsx (Present Characters)",
    fields: [
      { key: "type", label: "Type (0-9)", type: "int", isId: true, required: true },
      { key: "character", label: "Character", type: "text", required: true },
      { key: "presentCharacter", label: "Present Character (trait)", type: "text" },
      { key: "summary", label: "Summary", type: "textarea" },
      { key: "financialPersonality", label: "Financial Personality (via others)", type: "textarea" },
      { key: "subconsciousMoneyBehaviors", label: "Subconscious Money Behaviors & Triggers", type: "textarea" },
      { key: "potentialFinanceChallenges", label: "Potential Finance Challenges", type: "textarea" },
      { key: "coachingPathway", label: "Targeted Financial Wellness Coaching Pathway", type: "textarea" },
      { key: "workEnvironment", label: "Work Environment (Base)", type: "textarea" },
      { key: "growPath", label: "Grow Path", type: "textarea" },
      { key: "personalityStyle", label: "Personality Style (MHA)", type: "textarea" },
      { key: "badHabits", label: "Bad Habits", type: "textarea" },
      { key: "socialInfluence", label: "Social Influence", type: "textarea" },
      { key: "talents", label: "Talents and Expertise", type: "textarea" },
      { key: "physicalHealth", label: "Possible Physical Health Issue", type: "textarea" },
    ],
  },
  {
    key: "fwm-real-intention",
    label: "FWM — Real Intention",
    sourceFile: "v1.0_Characteristics_FWM_DataSet.xlsx (Real Intention)",
    fields: [
      { key: "type", label: "Type (0-9)", type: "int", isId: true, required: true },
      { key: "character", label: "Character", type: "text", required: true },
      { key: "realIntention", label: "Real Intention", type: "text" },
      { key: "summary", label: "Summary", type: "textarea" },
      { key: "idealWorkplace", label: "Ideal Workplace", type: "textarea" },
      { key: "growPath", label: "Grow Path", type: "textarea" },
      { key: "motivateYourself", label: "Motivate Yourself", type: "textarea" },
      { key: "definingChallenge", label: "Defining the Challenge", type: "textarea" },
      { key: "coreValues", label: "Creating Your Core Values", type: "textarea" },
      { key: "possibleCareer", label: "Possible Career", type: "textarea" },
      { key: "coachingPathway", label: "Targeted Financial Wellness Coaching Pathway", type: "textarea" },
    ],
  },
  {
    key: "fwm-combination",
    label: "FWM — Present x Real Intention",
    sourceFile: "v1.0_Characteristics_FWM_DataSet.xlsx (Combination)",
    fields: [
      { key: "presentCharacter", label: "Present Character", type: "text", isId: true, required: true },
      { key: "realIntention", label: "Real Intention", type: "text", isId: true, required: true },
      { key: "financialBehaviourPattern", label: "Financial Behaviour Pattern", type: "textarea" },
      { key: "careerThoughtProcess", label: "Career in Your Thought Process", type: "textarea" },
    ],
  },
  {
    key: "fwm-comm-learn",
    label: "FWM — Communication & Learning Style",
    sourceFile: "v1.0- DataStress_FWM.xlsx (Comm_Learn)",
    fields: [
      { key: "base", label: "Base sensory (e.g. VISUAL + Outward + Extrovert)", type: "text", isId: true, required: true },
      { key: "communicationStyle", label: "Communication Style", type: "textarea" },
      { key: "learningStyle", label: "Learning Style", type: "textarea" },
    ],
  },
  {
    key: "fwm-decision-making",
    label: "FWM — Decision Making & Financial Choice",
    sourceFile: "v1.0- DataStress_FWM.xlsx (Decision_Making)",
    fields: [
      { key: "baseNext", label: "Base - Next combination", type: "text", isId: true, required: true },
      { key: "decisionMaking", label: "Decision Making", type: "textarea" },
      { key: "financialChoice", label: "Financial Choice", type: "textarea" },
    ],
  },
  {
    key: "fwm-note-combination",
    label: "FWM — Note Pair Behaviour",
    sourceFile: "v1.1-EQ_Behaviour.xlsx (CombineMusicalNote)",
    fields: [
      { key: "note1", label: "Note 1", type: "text", isId: true, required: true },
      { key: "note2", label: "Note 2", type: "text", isId: true, required: true },
      { key: "behaviorPattern", label: "Behavior Pattern", type: "textarea" },
      { key: "financialBehavior", label: "Financial Behavior", type: "textarea" },
    ],
  },
];

export function referenceTable(key: string): ReferenceTableConfig | undefined {
  return REFERENCE_TABLES.find((t) => t.key === key);
}
