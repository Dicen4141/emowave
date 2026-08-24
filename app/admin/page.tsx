"use client";

import { useCallback, useEffect, useState } from "react";

type PurchaseStatus = "pending" | "sent" | "resend";

type PurchaseRow = {
  orderId: number;
  assessmentId: string;
  customerId: string;
  customerEmail: string | null;
  slug: string;
  purchasedAt: string;
  status: PurchaseStatus;
  deliveredAt: string | null;
  subjectName: string | null;
  subjectRelationship: string | null;
};

type Summary = { total: number; today: number; pending: number; resend: number; sent: number };

// Wording is from the fulfilment side, not the database's: staff are asking
// "does this one still need me?", so a re-purchase reads as owed work rather
// than as the "sent" its delivery row would otherwise suggest.
const STATUS: Record<PurchaseStatus, { label: string; tint: string; ink: string }> = {
  pending: { label: "Not sent", tint: "#3a2318", ink: "#f0a86a" },
  resend: { label: "Bought again — resend", tint: "#38231f", ink: "#f08a7a" },
  sent: { label: "Sent", tint: "#16261e", ink: "#7fd3a3" },
};

const STATUS_TABS: { value: string; label: string; countKey?: keyof Summary }[] = [
  { value: "", label: "All" },
  { value: "pending", label: "Not sent", countKey: "pending" },
  { value: "resend", label: "Resend", countKey: "resend" },
  { value: "sent", label: "Sent", countKey: "sent" },
];

// The purchase's slug is the delivery vocabulary (see deliverySlug in
// lib/quantemoDelivery.ts), which is a theme name or a variant name.
// Only shown when the report is for someone other than the buyer — a "self"
// chip on every ordinary order would be noise.
const RELATIONSHIP_LABEL: Record<string, string> = {
  child: "child",
  parent: "parent",
  spouse: "spouse",
};

const REPORT_LABEL: Record<string, string> = {
  overview: "Overview (1 page)",
  full: "Full Report",
  fwm: "Financial Wealth (FWM)",
  career: "Career",
  relationship: "Relationship",
};

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const PAGE_SIZE = 10;

export default function AdminDashboard() {
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [slugs, setSlugs] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalMatching, setTotalMatching] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // `search` is what's in the box; `query` is what's actually been sent. They
  // diverge for the debounce interval below so a fetch doesn't fire on every
  // keystroke.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Any change to what's being asked for starts again at page 1 — staying on
  // page 4 of a result set that just shrank to one page reads as "no results".
  useEffect(() => {
    setPage(1);
  }, [query, status, slug]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    if (slug) params.set("slug", slug);
    setLoading(true);
    fetch(`/api/purchases?${params}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Could not load orders."))))
      .then((data) => {
        setPurchases(data.purchases ?? []);
        setSummary(data.summary ?? null);
        setSlugs(data.slugs ?? []);
        setTotalPages(data.totalPages ?? 1);
        setTotalMatching(data.totalMatching ?? 0);
        setPage(data.page ?? 1);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, query, status, slug]);

  useEffect(load, [load]);

  const outstanding = (summary?.pending ?? 0) + (summary?.resend ?? 0);
  const filtering = Boolean(query || status || slug);
  const firstOnPage = (page - 1) * PAGE_SIZE + 1;
  const lastOnPage = Math.min(page * PAGE_SIZE, totalMatching);

  return (
    <div className="container">
      <h1>Admin</h1>
      {/* The tool shortcuts that used to sit here (Extract / Reports / Manage
          Facts) are all still one click away in the nav above, so repeating
          them pushed the one thing that needs acting on below the fold. */}
      <p className="subtitle">Paid orders, newest first — open one to generate and send its report.</p>

      <div className="section-title">
        Report Orders
        {summary ? ` — ${summary.today} today, ${outstanding} awaiting delivery` : ""}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or order number…"
          style={{ width: "100%" }}
        />

        <div className="uploader" style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              className={status === t.value ? "" : "btn-secondary"}
              onClick={() => setStatus(t.value)}
            >
              {t.label}
              {t.countKey && summary ? ` (${summary[t.countKey]})` : ""}
            </button>
          ))}

          {/* Built from the slugs actually present, so it can never offer a
              report type that returns nothing. */}
          <select value={slug} onChange={(e) => setSlug(e.target.value)} style={{ marginLeft: "auto", maxWidth: 220 }}>
            <option value="">All report types</option>
            {slugs.map((s) => (
              <option key={s} value={s}>
                {REPORT_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p className="empty">{error}</p>}
      {loading && purchases.length === 0 && <p className="empty">Loading…</p>}

      {!error && (
        <>
          {totalMatching > 0 && (
            <p className="doc-meta" style={{ marginBottom: 10 }}>
              Showing {firstOnPage}–{lastOnPage} of {totalMatching}
              {filtering && summary ? ` matching · ${summary.total} orders in total` : ""}
            </p>
          )}

          {!loading && totalMatching === 0 && (
            <p className="empty">
              {filtering
                ? "No orders match that search."
                : "No paid orders yet — they appear here as Quantemo purchases come in."}
            </p>
          )}

          {purchases.map((p) => {
            const s = STATUS[p.status];
            return (
              <a
                key={p.orderId}
                href={`/admin/workspace?id=${p.assessmentId}`}
                style={{ display: "block", marginBottom: "12px" }}
              >
                <div className="card">
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <p className="doc-name" style={{ margin: 0 }}>
                      {p.subjectName ?? p.customerId}
                    </p>
                    {p.subjectRelationship && RELATIONSHIP_LABEL[p.subjectRelationship] && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 650,
                          padding: "2px 9px",
                          borderRadius: 999,
                          background: "#1b2333",
                          color: "#9db8e8",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {RELATIONSHIP_LABEL[p.subjectRelationship]}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 650,
                        padding: "2px 9px",
                        borderRadius: 999,
                        background: s.tint,
                        color: s.ink,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.label}
                    </span>
                    <span className="doc-meta" style={{ margin: 0, marginLeft: "auto" }}>
                      {timeAgo(p.purchasedAt)}
                    </span>
                  </div>
                  <p className="doc-meta" style={{ marginBottom: 0, marginTop: 6 }}>
                    {REPORT_LABEL[p.slug] ?? p.slug} · order #{p.orderId} ·{" "}
                    {new Date(p.purchasedAt).toLocaleString()}
                    {p.customerEmail ? ` · ${p.customerEmail}` : ""}
                    {p.deliveredAt ? ` · last sent ${new Date(p.deliveredAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
              </a>
            );
          })}

          {totalPages > 1 && (
            <div className="uploader" style={{ alignItems: "center", justifyContent: "center", marginTop: 4 }}>
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
                ← Previous
              </button>
              <span className="doc-meta" style={{ margin: "0 6px" }}>
                Page {page} of {totalPages}
              </span>
              <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage((n) => n + 1)}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
