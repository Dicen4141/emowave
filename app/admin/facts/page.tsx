"use client";

import { useEffect, useState } from "react";

type AssessmentSummary = { id: string; customerId: string; factCount: number; createdAt: string };
type FactRow = { id: string; section: string; label: string; value: unknown };
type AssessmentDetail = { id: string; customerId: string; customerEmail: string | null; status: string; facts: FactRow[] };

export default function FactsPage() {
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState("");

  const [detail, setDetail] = useState<AssessmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});
  const [editedLabels, setEditedLabels] = useState<Record<string, string>>({});
  const [savingFactId, setSavingFactId] = useState<string | null>(null);
  const [savedFactId, setSavedFactId] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [savedEmail, setSavedEmail] = useState(false);

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
    if (!selectedAssessmentId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    fetch(`/api/assessments/${selectedAssessmentId}`)
      .then((res) => res.json())
      .then((data: AssessmentDetail) => {
        setDetail(data);
        setEmailDraft(data.customerEmail ?? "");
        setSavedEmail(false);
        const initialValues: Record<string, string> = {};
        const initialLabels: Record<string, string> = {};
        for (const f of data.facts ?? []) {
          initialValues[f.id] = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
          initialLabels[f.id] = f.label;
        }
        setEditedValues(initialValues);
        setEditedLabels(initialLabels);
      })
      .finally(() => setDetailLoading(false));
  }, [selectedAssessmentId]);

  async function handleSaveEmail() {
    if (!selectedAssessmentId) return;
    setSavingEmail(true);
    setSavedEmail(false);
    try {
      const res = await fetch(`/api/assessments/${selectedAssessmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerEmail: emailDraft }),
      });
      if (res.ok) setSavedEmail(true);
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleSaveFact(factId: string) {
    setSavingFactId(factId);
    setSavedFactId(null);
    try {
      const res = await fetch(`/api/facts/${factId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editedValues[factId] ?? "", label: editedLabels[factId] ?? "" }),
      });
      if (res.ok) setSavedFactId(factId);
    } finally {
      setSavingFactId(null);
    }
  }

  return (
    <div className="container wide">
      <h1>Manage Facts</h1>
      <p className="subtitle">
        Every field shown here is one row in the <code>report_facts</code> table (Supabase) — the id next to each
        one is that row&apos;s primary key. Edit the title, the value, or both, then click Save to write it straight
        back to that row.
      </p>

      <div className="card">
        {assessments.length === 0 ? (
          <p className="empty">
            No assessments with extracted facts yet — use <a href="/admin/extract">Extract</a> first.
          </p>
        ) : (
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
        )}
      </div>

      {selectedAssessmentId && detail && (
        <div className="card">
          <label style={{ display: "block", marginBottom: "4px" }}>
            Client email <span style={{ fontWeight: 400, color: "var(--muted, #6b7280)" }}>(matched against Quantemo for age lookup)</span>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="email"
              value={emailDraft}
              onChange={(e) => {
                setEmailDraft(e.target.value);
                setSavedEmail(false);
              }}
              placeholder="client@example.com"
              style={{ flex: 1 }}
            />
            <button onClick={handleSaveEmail} disabled={savingEmail || emailDraft === (detail.customerEmail ?? "")}>
              {savingEmail ? "Saving…" : "Save"}
            </button>
            {savedEmail && <span className="saved">✓ Saved</span>}
          </div>
        </div>
      )}

      {selectedAssessmentId && (
        <div className="card">
          {detailLoading && <p className="empty">Loading…</p>}
          {!detailLoading && detail && detail.facts.length === 0 && (
            <p className="empty">This assessment has no facts.</p>
          )}
          {!detailLoading &&
            detail?.facts.map((f) => (
              <div key={f.id} className="fact-row">
                <p className="doc-meta" style={{ margin: "0 0 6px" }}>
                  <code>report_facts</code>, row <code>{f.id}</code> · section: {f.section}
                </p>
                <label style={{ display: "block", marginBottom: "4px" }}>Title (label)</label>
                <input
                  type="text"
                  value={editedLabels[f.id] ?? ""}
                  onChange={(e) => setEditedLabels((prev) => ({ ...prev, [f.id]: e.target.value }))}
                  style={{ fontWeight: 600, marginBottom: "10px" }}
                />
                <label style={{ display: "block", marginBottom: "4px" }}>Value</label>
                <textarea
                  value={editedValues[f.id] ?? ""}
                  onChange={(e) => setEditedValues((prev) => ({ ...prev, [f.id]: e.target.value }))}
                  rows={3}
                />
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "8px" }}>
                  <button
                    onClick={() => handleSaveFact(f.id)}
                    disabled={savingFactId === f.id || !(editedLabels[f.id] ?? "").trim()}
                  >
                    {savingFactId === f.id ? "Saving…" : "Save"}
                  </button>
                  {savedFactId === f.id && <span className="saved">✓ Saved</span>}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
