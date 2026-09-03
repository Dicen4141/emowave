"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { REFERENCE_TABLES, type ReferenceField } from "@/lib/referenceTables";

type Row = Record<string, string | number | null>;

// Fixed per-column widths, sized by field type — a short code/word column
// stays narrow, a paragraph column gets real room to wrap in. table-layout:
// fixed + these widths is what keeps every row's columns lined up cleanly
// even though row heights vary a lot (one field might be "JOY", the next a
// 4-sentence paragraph).
function colWidth(f: ReferenceField): number {
  if (f.type === "int" || f.type === "float") return 90;
  if (f.type === "textarea") return 300;
  return 140;
}

// Every short field at the START of a table — not just the strict id — stays
// pinned on the left while the long text columns scroll underneath, so the
// row's "at a glance" identity (e.g. Note + Music Note, or Stress From +
// Stress To) is always visible. That's the leading run of fields up to the
// first "textarea" one; once a long field shows up, nothing after it pins,
// even if a later field happens to also be short (a frozen column with gaps
// in the middle would be confusing to scroll past).
function leadingStickyFields(fields: ReferenceField[]): ReferenceField[] {
  const leading: ReferenceField[] = [];
  for (const f of fields) {
    if (f.type === "textarea") break;
    leading.push(f);
  }
  return leading;
}

function stickyLeft(field: ReferenceField, fields: ReferenceField[]): number | null {
  const leading = leadingStickyFields(fields);
  const idx = leading.findIndex((f) => f.key === field.key);
  if (idx === -1) return null;
  return leading.slice(0, idx).reduce((sum, f) => sum + colWidth(f), 0);
}

function rowKey(fields: ReferenceField[], row: Row): string {
  return fields
    .filter((f) => f.isId)
    .map((f) => row[f.key])
    .join("::");
}

// Carries a row's id field(s) through the URL to the edit page — works the
// same way for a single-key table (code=c19) and a composite-key one
// (language=English&number=9).
function editHref(tableKey: string, fields: ReferenceField[], row?: Row): string {
  if (!row) return `/admin/reference-data/${tableKey}/edit`;
  const params = new URLSearchParams();
  for (const f of fields) if (f.isId) params.set(f.key, String(row[f.key] ?? ""));
  return `/admin/reference-data/${tableKey}/edit?${params.toString()}`;
}

function ReferenceDataView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tableKey = REFERENCE_TABLES.some((t) => t.key === searchParams.get("table")) ? searchParams.get("table")! : REFERENCE_TABLES[0].key;
  const config = REFERENCE_TABLES.find((t) => t.key === tableKey)!;

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  function loadRows() {
    setLoading(true);
    setLoadError("");
    fetch(`/api/reference-data/${tableKey}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load.");
        setRows(data.rows ?? []);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadRows();
    setSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => config.fields.some((f) => String(row[f.key] ?? "").toLowerCase().includes(q)));
  }, [rows, search, config.fields]);

  // Takes the row's render key rather than recomputing it: rowKey() collapses
  // to "" for a row whose id column came back empty, and every such row would
  // then compare equal to deletingKey and show "Deleting…" at once.
  async function handleDelete(row: Row, key: string) {
    if (!confirm("Delete this row? This affects every client's report that looks it up.")) return;
    setDeletingKey(key);
    try {
      const idPayload: Record<string, string> = {};
      for (const f of config.fields) if (f.isId) idPayload[f.key] = String(row[f.key]);
      const res = await fetch(`/api/reference-data/${tableKey}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(idPayload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed.");
      loadRows();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <>
      <div className="container wide" style={{ paddingBottom: 0 }}>
        <h1>Reference Data</h1>
        <p className="subtitle">
          The vendor lookup tables every report reads from (stress bands, character types, note behaviors, and the rest) —
          editable here directly instead of the Supabase table editor. Superadmin only, since a change here affects every
          client's report, not just one.
        </p>

        <div className="card">
          <label htmlFor="table-select">Table</label>
          <select
            id="table-select"
            value={tableKey}
            onChange={(e) => router.push(`/admin/reference-data?table=${e.target.value}`)}
            style={{ marginTop: 6 }}
          >
            {REFERENCE_TABLES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="doc-meta" style={{ marginTop: 8 }}>
            Mirrors <code>{config.sourceFile}</code>.
          </p>
        </div>
      </div>

      <div style={{ padding: "0 32px 96px" }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0 }}>{config.label}</h3>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="search"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: 220 }}
                aria-label="Search rows"
              />
              <Link href={editHref(tableKey, config.fields)} className="btn-secondary" style={{ whiteSpace: "nowrap" }}>
                + Add row
              </Link>
            </div>
          </div>

          {loading && <p className="empty">Loading…</p>}
          {!loading && loadError && <p className="error">⚠ {loadError}</p>}
          {!loading && !loadError && rows.length === 0 && <p className="empty">No rows yet.</p>}
          {!loading && !loadError && rows.length > 0 && filteredRows.length === 0 && <p className="empty">No rows match "{search}".</p>}

          {!loading && !loadError && filteredRows.length > 0 && (
            <>
              {search && (
                <p className="doc-meta" style={{ marginBottom: 10 }}>
                  {filteredRows.length} of {rows.length} rows
                </p>
              )}
              <div className="ref-table-wrap">
                <table className="ref-table">
                  <colgroup>
                    {config.fields.map((f) => (
                      <col key={f.key} style={{ width: colWidth(f) }} />
                    ))}
                    <col style={{ width: 150 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      {config.fields.map((f) => {
                        const left = stickyLeft(f, config.fields);
                        return (
                          <th key={f.key} className={left !== null ? "ref-th-sticky" : undefined} style={left !== null ? { left } : undefined}>
                            {f.label}
                          </th>
                        );
                      })}
                      <th className="ref-th-sticky-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {/* rowKey() is the row's real identity, but it joins the
                        id columns and so collapses to "" whenever those come
                        back empty or null — and two such rows are then the
                        same React key, which is what the duplicate-key warning
                        was. Falling back to the row's position keeps every key
                        distinct; it's only ever used for rows that had no
                        identity of their own to begin with. */}
                    {filteredRows.map((row, i) => {
                      const key = rowKey(config.fields, row) || `row-${i}`;
                      return (
                        <tr key={key}>
                          {config.fields.map((f) => {
                            const left = stickyLeft(f, config.fields);
                            const classes = [f.isId ? "ref-td-id" : "", left !== null ? "ref-td-sticky" : ""].filter(Boolean).join(" ");
                            return (
                              <td key={f.key} className={classes || undefined} style={left !== null ? { left } : undefined}>
                                {row[f.key] ?? ""}
                              </td>
                            );
                          })}
                          <td className="ref-td-actions ref-td-sticky-right">
                            <Link href={editHref(tableKey, config.fields, row)} className="btn-secondary">
                              Edit
                            </Link>
                            <button className="btn-danger" onClick={() => handleDelete(row, key)} disabled={deletingKey === key}>
                              {deletingKey === key ? "Deleting…" : "Delete"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// useSearchParams() opts a page out of static prerendering unless it sits
// under a Suspense boundary — without one, `next build` fails the whole
// export rather than degrading. The boundary is what lets Next ship the
// static shell and fill the URL-dependent part in on the client.
export default function ReferenceDataPage() {
  return (
    <Suspense fallback={<p className="empty">Loading reference data…</p>}>
      <ReferenceDataView />
    </Suspense>
  );
}
