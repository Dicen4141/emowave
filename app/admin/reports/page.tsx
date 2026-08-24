"use client";

import { useEffect, useState } from "react";

type AssessmentSummary = { id: string; customerId: string; factCount: number; createdAt: string };

// Same underlying facts as the full report — each theme just emphasizes a
// different subset of sections (see THEME_SECTIONS in lib/renderEwFullReport.ts).
// Finance is deliberately absent: the Financial Wealth Management report
// replaced it, and that one is a separate report type with its own renderer
// and vendor data, so it's driven by ?variant=fwm below rather than a theme.
const THEMES = [
  { value: "career", label: "Career" },
  { value: "relationship", label: "Relationship" },
] as const;

type StressContent = { description: string | null } | null;
type EmotionalStateContent = {
  note1ReactionDesc: string | null;
  note2ReactionDesc: string | null;
  publicSelfFull: string | null;
  privateSelfFull: string | null;
  frequentEmotionDesc: string | null;
  coreEmotionDesc: string | null;
  empoweringDesc: string | null;
  disempoweringDesc: string | null;
} | null;
type SensoryAttributesContent = { baseDesc: string | null; nextDesc: string | null } | null;
type PresentCharacterContent = { presentTrait: string | null; presentSummary: string | null; realTrait: string | null; realSummary: string | null } | null;
type JourneyOverviewContent = { noteBalanceValues: number[] | null } | null;
type AttributeRow = { id: string; kind?: string; rank: number; label: string; description: string };
type FactRow = { id: string; section: string; label: string; value: unknown };

type AssessmentDetail = {
  id: string;
  customerId: string;
  status: string;
  facts: FactRow[];
  stressContent: StressContent;
  emotionalStateContent: EmotionalStateContent;
  sensoryAttributesContent: SensoryAttributesContent;
  presentCharacterContent: PresentCharacterContent;
  topAttributeContent: AttributeRow[];
  wellnessChallengeContent: AttributeRow[];
  journeyOverviewContent: JourneyOverviewContent;
};

// Mirrors lib/renderEwFullReport.ts's fact() helper — reads a raw
// report_facts value by label.
function fact(facts: FactRow[], label: string): string {
  const f = facts.find((x) => x.label === label);
  return f && typeof f.value === "string" ? f.value : "";
}

// The report itself falls back from Gemini content → raw facts through
// several layers (see renderEwFullReport.ts) — a client with no Gemini
// content yet still shows real text in the PDF, just not Gemini-polished.
// This editor should show and let staff edit whatever actually ends up on
// the page, not just the pure-Gemini layer, so these mirror those same
// fallback chains field-for-field instead of stopping at the content table.
function note1Fallback(d: AssessmentDetail): string {
  return (
    d.emotionalStateContent?.note1ReactionDesc ||
    d.emotionalStateContent?.publicSelfFull ||
    fact(d.facts, "Emotional State - Note 1 reaction") ||
    fact(d.facts, "Public Self - full").replace(/^[A-G]#?-(Major|Minor)\s*\([^)]+\)\s*/, "")
  );
}
function note2Fallback(d: AssessmentDetail): string {
  return (
    d.emotionalStateContent?.note2ReactionDesc ||
    d.emotionalStateContent?.privateSelfFull ||
    fact(d.facts, "Emotional State - Note 2 reaction") ||
    fact(d.facts, "Private Self - full").replace(/^[A-G]#?-(Major|Minor)\s*\([^)]+\)\s*/, "")
  );
}
function freqEmotionFallback(d: AssessmentDetail): string {
  return (
    d.emotionalStateContent?.frequentEmotionDesc ||
    fact(d.facts, "Frequent Emotion - description") ||
    fact(d.facts, "Frequent Emotion (Mind Report) - description")
  );
}
function coreEmotionFallback(d: AssessmentDetail): string {
  return (
    d.emotionalStateContent?.coreEmotionDesc || fact(d.facts, "Core Emotion - description") || fact(d.facts, "Core Emotion (Mind Report) - description")
  );
}
function empoweringFallback(d: AssessmentDetail): string {
  return d.emotionalStateContent?.empoweringDesc || fact(d.facts, "Empowering Emotion");
}
function disempoweringFallback(d: AssessmentDetail): string {
  return d.emotionalStateContent?.disempoweringDesc || fact(d.facts, "Dis-empowering Emotion");
}
function stressFallback(d: AssessmentDetail): string {
  const stressTypeFact = d.facts.find((f) => f.label.startsWith("Stress type (") && typeof f.value === "string");
  return d.stressContent?.description || fact(d.facts, "Stress Level - description") || String(stressTypeFact?.value ?? "");
}
function sensoryBaseFallback(d: AssessmentDetail): string {
  return d.sensoryAttributesContent?.baseDesc || fact(d.facts, "Sensory Attributes - BASE");
}
function sensoryNextFallback(d: AssessmentDetail): string {
  return d.sensoryAttributesContent?.nextDesc || fact(d.facts, "Sensory Attributes - NEXT");
}
function presentTraitFallback(d: AssessmentDetail): string {
  return d.presentCharacterContent?.presentTrait || fact(d.facts, "Present Character - trait") || fact(d.facts, "Sensory persona (Base)");
}
function presentSummaryFallback(d: AssessmentDetail): string {
  return d.presentCharacterContent?.presentSummary || fact(d.facts, "Present Character - summary") || fact(d.facts, "Sensory - first type (Base)");
}
function realTraitFallback(d: AssessmentDetail): string {
  return d.presentCharacterContent?.realTrait || fact(d.facts, "Real Intention - trait") || fact(d.facts, "Sensory persona (Next)");
}
function realSummaryFallback(d: AssessmentDetail): string {
  return d.presentCharacterContent?.realSummary || fact(d.facts, "Real Intention - summary") || fact(d.facts, "Sensory - second type (Next)");
}

// One field editor — label, textarea, its own save state. `onSave` returns
// a promise so the button can show its own "Saving…"/"✓ Saved" state
// without the parent needing to track per-field status.
function FieldEditor({ label, value, onSave }: { label: string; value: string; onSave: (next: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(value);
    setSaved(false);
  }, [value]);

  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", marginBottom: "4px" }}>{label}</label>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        rows={draft.length > 200 ? 4 : 2}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "4px" }}>
        <button
          onClick={async () => {
            setSaving(true);
            setSaved(false);
            try {
              await onSave(draft);
              setSaved(true);
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving || draft === value}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="saved">✓ Saved</span>}
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {children}
    </div>
  );
}

export default function ReportsPage() {
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState("");
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  // Bumped every time the preview is opened so the iframe key/src is always
  // unique — without it, toggling "Preview PDF" off/on for the same
  // assessment reuses the exact same URL, and some browsers reuse the
  // previous PDF instead of re-rendering it fresh even with the server's
  // Cache-Control: no-store header.
  const [previewNonce, setPreviewNonce] = useState(0);
  // Extra query string the preview appends to /api/generate-report — "" is the
  // default full report, "&variant=fwm" the Financial Wealth one. Kept as the
  // raw suffix rather than a parsed shape because that's exactly what the
  // endpoint takes, so adding a previewable report later needs no new state.
  const [previewQuery, setPreviewQuery] = useState("");
  const [previewLabel, setPreviewLabel] = useState("Full Report");
  const [showEditor, setShowEditor] = useState(false);
  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Opening the same report twice in a row must still re-render it, hence the
  // nonce — see previewNonce above.
  function openPreview(query: string, label: string) {
    setPreviewQuery(query);
    setPreviewLabel(label);
    setShowPdfPreview(true);
    setPreviewNonce((n) => n + 1);
  }

  useEffect(() => {
    fetch("/api/assessments")
      .then((res) => res.json())
      .then((data) => {
        const list: AssessmentSummary[] = data.assessments ?? [];
        setAssessments(list);
        if (list.length > 0) setSelectedAssessmentId(list[0].id);
      });
  }, []);

  useEffect(() => {
    setShowPdfPreview(false);
  }, [selectedAssessmentId]);

  function loadDetail() {
    if (!selectedAssessmentId) return;
    setDetailLoading(true);
    fetch(`/api/assessments/${selectedAssessmentId}`)
      .then((res) => res.json())
      .then((data: AssessmentDetail) => setDetail(data))
      .finally(() => setDetailLoading(false));
  }

  useEffect(() => {
    setDetail(null);
    if (showEditor) loadDetail();
  }, [selectedAssessmentId, showEditor]);

  async function saveSingleton(table: string, field: string, next: string) {
    const res = await fetch("/api/enhanced-content/singleton", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, assessmentId: selectedAssessmentId, data: { [field]: next } }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    loadDetail();
  }

  async function saveRow(table: string, id: string, field: "label" | "description", next: string) {
    const res = await fetch("/api/enhanced-content/row", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, id, [field]: next }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    loadDetail();
  }

  return (
    <div className="container">
      <h1>Reports</h1>
      <p className="subtitle">
        Pick a saved assessment and generate its PDF on demand — nothing is generated automatically, only when you
        click the button.
      </p>
      <div className="card">
        {assessments.length === 0 ? (
          <p className="empty">
            No assessments with extracted facts yet — use <a href="/admin/extract">Extract</a> first.
          </p>
        ) : (
          <>
            <div className="uploader">
              <select
                value={selectedAssessmentId}
                onChange={(e) => setSelectedAssessmentId(e.target.value)}
                aria-label="Assessment"
              >
                {assessments.map((a) => (
                  <option key={a.id} value={a.id}>
                    #{a.id} — {a.customerId} ({a.factCount} facts, {new Date(a.createdAt).toLocaleString()})
                  </option>
                ))}
              </select>
              {selectedAssessmentId && (
                <>
                  <a href={`/api/generate-report?assessmentId=${selectedAssessmentId}&variant=overview`} target="_blank" rel="noopener noreferrer">
                    <button>Overview (1 page)</button>
                  </a>
                  <a href={`/api/generate-report?assessmentId=${selectedAssessmentId}`} target="_blank" rel="noopener noreferrer">
                    <button className="btn-secondary">Generate &amp; Open PDF</button>
                  </a>
                  <a href={`/report/${selectedAssessmentId}`} target="_blank" rel="noopener noreferrer">
                    <button className="btn-secondary">Open User-Facing Page</button>
                  </a>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      // Only a toggle for the report it actually shows —
                      // while FWM is in the pane this switches to the full
                      // report rather than closing, which is what a button
                      // labelled "Preview PDF" should do.
                      if (showPdfPreview && previewQuery === "") setShowPdfPreview(false);
                      else openPreview("", "Full Report");
                    }}
                  >
                    {showPdfPreview && previewQuery === "" ? "Hide Preview" : "Preview PDF"}
                  </button>
                  <button className="btn-secondary" onClick={() => setShowEditor((v) => !v)}>
                    {showEditor ? "Hide Content Editor" : "Edit Report Content"}
                  </button>
                </>
              )}
            </div>
            {selectedAssessmentId && (
              <div className="uploader" style={{ marginTop: "8px" }}>
                <span className="doc-meta" style={{ alignSelf: "center" }}>Themed reports (same data, different focus):</span>
                {THEMES.map((t) => (
                  <a
                    key={t.value}
                    href={`/api/generate-report?assessmentId=${selectedAssessmentId}&theme=${t.value}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <button className="btn-secondary">{t.label} PDF</button>
                  </a>
                ))}
                {/* The report that replaced the Finance theme — a separate
                    type with its own renderer and vendor reference tables, so
                    it takes ?variant= rather than ?theme=. Opens in the
                    preview pane; the link beside it is the new-tab route. */}
                <button
                  className="btn-secondary"
                  onClick={() => openPreview("&variant=fwm", "Financial Wealth Management (FWM)")}
                >
                  Preview Financial Wealth (FWM)
                </button>
                <a
                  href={`/api/generate-report?assessmentId=${selectedAssessmentId}&variant=fwm`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <button className="btn-secondary">FWM PDF ↗</button>
                </a>
                <button
                  onClick={() => {
                    for (const t of THEMES) {
                      window.open(`/api/generate-report?assessmentId=${selectedAssessmentId}&theme=${t.value}`, "_blank", "noopener,noreferrer");
                    }
                    window.open(`/api/generate-report?assessmentId=${selectedAssessmentId}&variant=fwm`, "_blank", "noopener,noreferrer");
                  }}
                >
                  Generate All 3
                </button>
                <a href={`/admin/mind-map/${selectedAssessmentId}`} target="_blank" rel="noopener noreferrer">
                  <button className="btn-secondary">Mind Map</button>
                </a>
                <a href={`/admin/workspace?id=${selectedAssessmentId}`} target="_blank" rel="noopener noreferrer">
                  <button className="btn-secondary">Open Workspace</button>
                </a>
              </div>
            )}
            {showPdfPreview && selectedAssessmentId && (
              <>
                <div
                  className="uploader"
                  style={{ marginTop: "16px", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span className="doc-meta">Previewing: {previewLabel}</span>
                  <button className="btn-secondary" onClick={() => setShowPdfPreview(false)}>
                    Hide Preview
                  </button>
                </div>
                <iframe
                  key={`${selectedAssessmentId}-${previewQuery}-${previewNonce}`}
                  src={`/api/generate-report?assessmentId=${selectedAssessmentId}${previewQuery}&t=${previewNonce}`}
                  title={`${previewLabel} preview`}
                  style={{
                    width: "100%",
                    height: "80vh",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    marginTop: "8px",
                    background: "var(--bg-soft)",
                  }}
                />
              </>
            )}
          </>
        )}
      </div>

      {showEditor && selectedAssessmentId && (
        <>
          <p className="subtitle" style={{ marginTop: "1rem" }}>
            This is the Gemini-generated content for <strong>{detail?.customerId ?? "…"}</strong> — the version that
            actually appears in the PDF. Raw extracted text lives in <a href="/admin/facts">Manage Facts</a> instead.
            Edit anything below, save, then re-generate the PDF above to see the change.
          </p>
          {detailLoading && <p className="empty">Loading…</p>}
          {!detailLoading && detail && (
            <>
              <SectionCard title="1. Stress Level">
                <FieldEditor label="Description" value={stressFallback(detail)} onSave={(v) => saveSingleton("stress", "description", v)} />
              </SectionCard>

              <SectionCard title="2. Emotional State">
                <FieldEditor
                  label="Note 1 reaction"
                  value={note1Fallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "note1ReactionDesc", v)}
                />
                <FieldEditor
                  label="Note 2 reaction"
                  value={note2Fallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "note2ReactionDesc", v)}
                />
                <FieldEditor
                  label="Frequent Emotion description"
                  value={freqEmotionFallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "frequentEmotionDesc", v)}
                />
                <FieldEditor
                  label="Core Emotion description"
                  value={coreEmotionFallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "coreEmotionDesc", v)}
                />
                <FieldEditor
                  label="Empowering Emotion"
                  value={empoweringFallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "empoweringDesc", v)}
                />
                <FieldEditor
                  label="Dis-empowering Emotion"
                  value={disempoweringFallback(detail)}
                  onSave={(v) => saveSingleton("emotionalState", "disempoweringDesc", v)}
                />
              </SectionCard>

              <SectionCard title="3. Sensory Attributes">
                <FieldEditor label="Base" value={sensoryBaseFallback(detail)} onSave={(v) => saveSingleton("sensoryAttributes", "baseDesc", v)} />
                <FieldEditor label="Next" value={sensoryNextFallback(detail)} onSave={(v) => saveSingleton("sensoryAttributes", "nextDesc", v)} />
              </SectionCard>

              <SectionCard title="5. Present Character and Real Intention">
                <FieldEditor
                  label="Present Character — trait"
                  value={presentTraitFallback(detail)}
                  onSave={(v) => saveSingleton("presentCharacter", "presentTrait", v)}
                />
                <FieldEditor
                  label="Present Character — summary"
                  value={presentSummaryFallback(detail)}
                  onSave={(v) => saveSingleton("presentCharacter", "presentSummary", v)}
                />
                <FieldEditor
                  label="Real Intention — trait"
                  value={realTraitFallback(detail)}
                  onSave={(v) => saveSingleton("presentCharacter", "realTrait", v)}
                />
                <FieldEditor
                  label="Real Intention — summary"
                  value={realSummaryFallback(detail)}
                  onSave={(v) => saveSingleton("presentCharacter", "realSummary", v)}
                />
              </SectionCard>

              <SectionCard title="Your Top 5 Constructive Attributes">
                {detail.topAttributeContent.filter((r) => r.kind === "constructive").length === 0 && <p className="empty">None yet.</p>}
                {detail.topAttributeContent
                  .filter((r) => r.kind === "constructive")
                  .map((r) => (
                    <div key={r.id} style={{ marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
                      <FieldEditor label={`#${r.rank} — Label`} value={r.label} onSave={(v) => saveRow("topAttribute", r.id, "label", v)} />
                      <FieldEditor label="Description" value={r.description} onSave={(v) => saveRow("topAttribute", r.id, "description", v)} />
                    </div>
                  ))}
              </SectionCard>

              <SectionCard title="Your Top 5 Restrictive Attributes">
                {detail.topAttributeContent.filter((r) => r.kind === "restrictive").length === 0 && <p className="empty">None yet.</p>}
                {detail.topAttributeContent
                  .filter((r) => r.kind === "restrictive")
                  .map((r) => (
                    <div key={r.id} style={{ marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
                      <FieldEditor label={`#${r.rank} — Label`} value={r.label} onSave={(v) => saveRow("topAttribute", r.id, "label", v)} />
                      <FieldEditor label="Description" value={r.description} onSave={(v) => saveRow("topAttribute", r.id, "description", v)} />
                    </div>
                  ))}
              </SectionCard>

              <SectionCard title="Wellness Challenge">
                {detail.wellnessChallengeContent.length === 0 && <p className="empty">None yet.</p>}
                {detail.wellnessChallengeContent.map((r) => (
                  <div key={r.id} style={{ marginBottom: "0.75rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
                    <FieldEditor label={`#${r.rank} — Label`} value={r.label} onSave={(v) => saveRow("wellnessChallenge", r.id, "label", v)} />
                    <FieldEditor label="Description" value={r.description} onSave={(v) => saveRow("wellnessChallenge", r.id, "description", v)} />
                  </div>
                ))}
              </SectionCard>

              <SectionCard title="8. Journey Overview — Note Balance values">
                <FieldEditor
                  label="C, C#, D, D#, E, F, F#, G, G#, A, A#, B (comma-separated)"
                  value={(detail.journeyOverviewContent?.noteBalanceValues ?? []).join(", ")}
                  onSave={(v) => {
                    const values = v
                      .split(",")
                      .map((s) => Number(s.trim()))
                      .filter((n) => Number.isFinite(n));
                    if (values.length !== 12) throw new Error("Must be exactly 12 numbers.");
                    return saveSingleton("journeyOverview", "noteBalanceValues", values as unknown as string);
                  }}
                />
              </SectionCard>
            </>
          )}
        </>
      )}
    </div>
  );
}
