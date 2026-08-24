"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { referenceTable } from "@/lib/referenceTables";

type Row = Record<string, string | number | null>;

export default function EditReferenceRowPage() {
  const params = useParams<{ table: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const config = referenceTable(params.table);

  // Edit mode iff every id field showed up in the URL — a create link
  // (editHref with no row) carries none of them.
  const idFieldsFromUrl = useMemo(() => {
    if (!config) return null;
    const idFields = config.fields.filter((f) => f.isId);
    const values: Record<string, string> = {};
    for (const f of idFields) {
      const v = searchParams.get(f.key);
      if (v === null) return null;
      values[f.key] = v;
    }
    return values;
  }, [config, searchParams]);
  const isEdit = idFieldsFromUrl !== null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!config) return;
    if (!isEdit) {
      const blank: Record<string, string> = {};
      for (const f of config.fields) if (!(f.key === "id" && config.key === "stress-range")) blank[f.key] = "";
      setValues(blank);
      return;
    }
    setLoading(true);
    setLoadError("");
    fetch(`/api/reference-data/${config.key}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load.");
        const match = (data.rows as Row[]).find((row) => config.fields.filter((f) => f.isId).every((f) => String(row[f.key]) === idFieldsFromUrl![f.key]));
        if (!match) throw new Error("That row no longer exists — it may have been deleted.");
        const filled: Record<string, string> = {};
        for (const f of config.fields) filled[f.key] = match[f.key] === null || match[f.key] === undefined ? "" : String(match[f.key]);
        setValues(filled);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Failed to load."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.key, isEdit]);

  if (!config) {
    return (
      <div className="container">
        <p className="error">⚠ Unknown reference table "{params.table}".</p>
        <Link href="/admin/reference-data">← Back</Link>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`/api/reference-data/${config!.key}`, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      router.push(`/admin/reference-data?table=${config!.key}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container wide">
      <Link href={`/admin/reference-data?table=${config.key}`} className="studio-link" style={{ display: "inline-block", marginBottom: 8 }}>
        ← Back to {config.label}
      </Link>
      <h1>{isEdit ? `Edit row — ${config.label}` : `Add row — ${config.label}`}</h1>
      <p className="subtitle">Mirrors {config.sourceFile}. Affects every client's report that looks this up, not just one.</p>

      <div className="card">
        {loading && <p className="empty">Loading…</p>}
        {!loading && loadError && (
          <>
            <p className="error">⚠ {loadError}</p>
            <Link href={`/admin/reference-data?table=${config.key}`}>← Back to {config.label}</Link>
          </>
        )}

        {!loading && !loadError && (
          <form onSubmit={handleSubmit}>
            {config.fields.map((f) => {
              if (f.key === "id" && config.key === "stress-range" && !isEdit) return null; // autoincrement
              const disabled = isEdit && f.isId; // ids are the row's identity — not editable after creation
              return (
                <div key={f.key} style={{ marginBottom: 14 }}>
                  <label htmlFor={`field-${f.key}`}>
                    {f.label}
                    {f.required ? " *" : ""}
                  </label>
                  {f.type === "textarea" ? (
                    <textarea
                      id={`field-${f.key}`}
                      rows={4}
                      value={values[f.key] ?? ""}
                      disabled={disabled}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      style={{ marginTop: 4 }}
                    />
                  ) : (
                    <input
                      id={`field-${f.key}`}
                      type={f.type === "int" || f.type === "float" ? "number" : "text"}
                      step={f.type === "float" ? "any" : undefined}
                      value={values[f.key] ?? ""}
                      disabled={disabled}
                      required={f.required}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      style={{ marginTop: 4 }}
                    />
                  )}
                </div>
              );
            })}

            {saveError && (
              <p className="error" role="alert">
                ⚠ {saveError}
              </p>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              <Link href={`/admin/reference-data?table=${config.key}`} className="btn-secondary">
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
