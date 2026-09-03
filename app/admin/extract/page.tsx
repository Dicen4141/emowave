"use client";

import { useState } from "react";

type Fact = { label: string; text: string | null };
type ExtractResult = {
  fileName: string;
  ok: boolean;
  error?: string;
  template?: string;
  fields?: Fact[];
  assessmentId?: string;
  clientName?: string | null;
  mergedIntoExisting?: boolean;
  newRoundCreated?: boolean;
};

// Bullet markers ("• " or a dash used as a list marker) are just run
// together in the extracted text — break them onto their own line so a long
// field reads as a list instead of one wall-of-text paragraph. A "- " only
// counts as a list marker when it's preceded by whitespace/start-of-string
// and followed by a capital letter or digit, so words like "B-flat" or
// "self-critical" (no space after the dash) are left alone. Fields that are
// already newline-separated (e.g. "trait scores", one "NNN C - text" row per
// line) skip the dash heuristic entirely — running it anyway would insert a
// second break inside each row (the "C - text"/"R - text" marker mid-line),
// splitting one bullet into two.
function formatBullets(text: string | null): string {
  if (!text) return "";
  if (text.includes("\n")) return text.trim();
  return text
    .replace(/\s*•\s*/g, "\n• ")
    .replace(/(^|\s)-\s+(?=[A-Z0-9])/g, "$1\n- ")
    .trim();
}

export default function ExtractPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ExtractResult[]>([]);
  // See the matching checkbox in EmoSpace's "Add source" modal — off by
  // default so a routine re-upload (fixing a bad extraction) still corrects
  // the client's current round instead of forking their history.
  const [newRound, setNewRound] = useState(false);

  async function handleFactsUpload() {
    if (files.length === 0) return;
    setLoading(true);
    setResults([]);
    setProgress({ done: 0, total: files.length });

    // Uploaded one at a time (not in parallel) — later files in the same
    // batch may need to merge into an assessment a prior file in this same
    // batch just created (matched by client name), so each upload has to
    // finish before the next one starts. Only the first file forces a new
    // round (see the matching comment in EmoSpace's handleUpload) — the
    // rest of the batch joins whatever that first file just created.
    const collected: ExtractResult[] = [];
    let remainingForcesNewRound = newRound;
    for (const file of files) {
      const formData = new FormData();
      formData.append("pdf", file);
      formData.append("newRound", String(remainingForcesNewRound));
      remainingForcesNewRound = false;
      try {
        const res = await fetch("/api/extract-facts", { method: "POST", body: formData });
        const data = await res.json();
        collected.push({ fileName: file.name, ok: res.ok, ...data });
      } catch (e) {
        collected.push({ fileName: file.name, ok: false, error: e instanceof Error ? e.message : "Network error." });
      }
      setResults([...collected]);
      setProgress((p) => (p ? { done: p.done + 1, total: p.total } : null));
    }

    setLoading(false);
    setProgress(null);
    setNewRound(false);
  }

  return (
    <div className="container">
      <h1>Report Field Extractor</h1>
      <p className="subtitle">
        Upload one or more PDFs (Aquera Mind Report, Emotional Notes Report, iEmoWave Full) at once — no circling
        needed. Each is processed in turn; if a client&apos;s name matches an existing assessment (including another
        file from this same batch), its facts get added there instead of creating a new one.
      </p>
      <div className="card">
        <div className="uploader">
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          <button onClick={handleFactsUpload} disabled={files.length === 0 || loading}>
            {loading
              ? `Extracting… ${progress ? `${progress.done}/${progress.total}` : ""}`
              : files.length > 1
                ? `Extract ${files.length} Files`
                : "Extract Report Fields"}
          </button>
        </div>
        {files.length > 1 && !loading && (
          <p className="doc-meta">{files.map((f) => f.name).join(", ")}</p>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={newRound} onChange={(e) => setNewRound(e.target.checked)} />
          <span className="doc-meta" style={{ margin: 0 }}>
            This is a new report, not a correction — keep the client&apos;s current round untouched and start a fresh one
          </span>
        </label>
      </div>

      {results.map((result, idx) => (
        <div className="card" key={idx}>
          <p className="doc-name">{result.fileName}</p>
          {!result.ok || !result.fields ? (
            <p className="error">⚠ {result.error ?? "Something went wrong."}</p>
          ) : (
            <>
              <p className="doc-meta">
                {result.template} — {result.fields.filter((f) => f.text !== null).length}/{result.fields.length}{" "}
                fields found
              </p>
              <p className="doc-meta">
                Client: {result.clientName ?? "(name not found, used filename)"} · Assessment #{result.assessmentId}{" "}
                {result.mergedIntoExisting
                  ? "(merged into existing round)"
                  : result.newRoundCreated
                    ? "(new round for an existing client)"
                    : "(new client)"}
              </p>
              {result.fields.map((f, i) => (
                <div key={i} className="doc-meta" style={{ marginTop: "0.75rem", whiteSpace: "pre-line" }}>
                  <strong>{f.label}:</strong> {f.text ? formatBullets(f.text) : "⚠ not found"}
                </div>
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
