"use client";

import { useEffect, useState } from "react";

type EmowaveBuyerSummary = {
  buyerId: number;
  buyerName: string;
  buyerEmail: string | null;
  totalOrders: number;
  latestOrderAt: string;
  pendingOrderIds: number[];
  importedAssessmentIds: string[];
};

type Round = {
  id: string;
  name: string;
  factCount: number;
  reportCount: number;
  age: number | null;
  createdAt: string;
  sources: string[];
};

type ClientRow = {
  id: string;
  quantemoUuid: string | null;
  linked: boolean;
  name: string;
  email: string | null;
  rounds: Round[];
};

type Filter = "all" | "unlinked" | "empty";

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const [buyers, setBuyers] = useState<EmowaveBuyerSummary[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState("");
  const [importingBuyerId, setImportingBuyerId] = useState<number | null>(null);

  function loadClients() {
    fetch("/api/clients")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load clients (HTTP ${res.status}).`);
        return res.json();
      })
      .then((data) => setClients(data.clients ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load clients."))
      .finally(() => setLoading(false));
  }

  function loadOrders() {
    setOrdersLoading(true);
    fetch("/api/quantemo-orders")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load Quantemo orders (HTTP ${res.status}).`);
        return res.json();
      })
      .then((data) => setBuyers(data.buyers ?? []))
      .catch((err) => setOrdersError(err instanceof Error ? err.message : "Failed to load Quantemo orders."))
      .finally(() => setOrdersLoading(false));
  }

  useEffect(() => {
    loadClients();
    loadOrders();
  }, []);

  // One buyer can have several pending purchases at once (e.g. bought 5
  // times before ever being imported) — import each in turn rather than
  // needing a separate bulk-import API route.
  async function handleImport(buyer: EmowaveBuyerSummary) {
    setImportingBuyerId(buyer.buyerId);
    try {
      for (const orderId of buyer.pendingOrderIds) {
        const res = await fetch(`/api/quantemo-orders/${orderId}/import`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Import failed for order #${orderId}.`);
      }
      loadOrders();
      loadClients();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImportingBuyerId(null);
    }
  }

  // "Empty" means every round has zero facts — that's the signature of the
  // records left behind when a PDF's name couldn't be read and the upload
  // fell back to the filename, so it's worth being able to isolate them.
  const isEmpty = (c: ClientRow) => c.rounds.every((r) => r.factCount === 0);

  const shown = clients.filter((c) => {
    if (filter === "unlinked" && c.linked) return false;
    if (filter === "empty" && !isEmpty(c)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q);
  });

  const linkedCount = clients.filter((c) => c.linked).length;

  return (
    <div className="container wide">
      <h1>Clients</h1>
      <p className="subtitle" style={{ marginBottom: 18 }}>
        Everyone on file, with the rounds and reports belonging to each. A client links to their Quantemo account by email — unlinked
        ones still work, but their repeat purchases can&apos;t be recognised as the same person.
      </p>

      <div className="card">
        <p className="doc-name" style={{ marginBottom: 4 }}>
          Recent Quantemo purchases
        </p>
        <p className="doc-meta" style={{ marginBottom: 14 }}>
          Paid orders for any EmoWave report, straight from Quantemo. This updates automatically once EmoWave is deployed
          with a public URL (Quantemo can then notify it directly) — until then, click Add to pull one in manually.
        </p>

        {ordersLoading && <p className="empty">Loading…</p>}
        {!ordersLoading && ordersError && <p className="error">⚠ {ordersError}</p>}
        {!ordersLoading && !ordersError && buyers.length === 0 && <p className="empty">No paid EmoWave orders yet.</p>}

        {!ordersLoading &&
          !ordersError &&
          buyers.map((b) => (
            <div className="round-row" key={b.buyerId}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="round-title">{b.buyerName}</div>
                <div className="round-meta">
                  {b.totalOrders} purchase{b.totalOrders === 1 ? "" : "s"} · latest {new Date(b.latestOrderAt).toLocaleDateString()}
                  {b.buyerEmail && ` · ${b.buyerEmail}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {b.importedAssessmentIds.length > 0 && (
                  <a className="tag tag-ok" href={`/admin/workspace?id=${b.importedAssessmentIds[0]}`}>
                    ✓ {b.importedAssessmentIds.length} in Workspace
                  </a>
                )}
                {b.pendingOrderIds.length > 0 && (
                  <button className="btn-secondary round-open" onClick={() => handleImport(b)} disabled={importingBuyerId === b.buyerId}>
                    {importingBuyerId === b.buyerId
                      ? "Adding…"
                      : `+ Add${b.pendingOrderIds.length > 1 ? ` ${b.pendingOrderIds.length}` : ""} to Workspace`}
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>

      <div className="card">
        <div className="client-toolbar">
          <input
            type="search"
            placeholder="Search name or email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search clients"
          />
          <div className="filter-chips">
            {(
              [
                ["all", `All (${clients.length})`],
                ["unlinked", `Not linked (${clients.length - linkedCount})`],
                ["empty", `No data (${clients.filter(isEmpty).length})`],
              ] as [Filter, string][]
            ).map(([value, label]) => (
              <button key={value} className="gen-option" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <p className="empty">Loading…</p>}
      {error && <p className="error">⚠ {error}</p>}
      {!loading && !error && shown.length === 0 && <p className="empty">No clients match.</p>}

      {shown.map((c) => (
        <div className="card client-card" key={c.id}>
          <div className="client-head">
            <div style={{ minWidth: 0 }}>
              <p className="doc-name" style={{ marginBottom: 2 }}>
                {c.name}
              </p>
              <p className="doc-meta" style={{ marginBottom: 0 }}>
                {c.linked ? (
                  <span className="tag tag-ok">✓ linked</span>
                ) : (
                  <span className="tag tag-warn">not linked</span>
                )}{" "}
                {c.email ?? "no email on file"} · {c.rounds.length} {c.rounds.length === 1 ? "round" : "rounds"}
              </p>
            </div>
          </div>

          {c.rounds.map((r, i) => (
            <div className="round-row" key={r.id}>
              <div className="round-no">{c.rounds.length - i}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="round-title">
                  #{r.id} — {r.name}
                </div>
                <div className="round-meta">
                  {r.factCount} facts
                  {r.age !== null && ` · age ${r.age}`}
                  {r.reportCount > 0 && ` · ${r.reportCount} stored report${r.reportCount === 1 ? "" : "s"}`}
                  {" · "}
                  {new Date(r.createdAt).toLocaleDateString()}
                </div>
                <div className="round-sources">
                  {r.sources.length > 0 ? (
                    r.sources.map((s) => (
                      <span className="tag" key={s}>
                        {s}
                      </span>
                    ))
                  ) : (
                    <span className="tag tag-warn">no sources</span>
                  )}
                </div>
              </div>
              <a className="btn-secondary round-open" href={`/admin/workspace?id=${r.id}`}>
                Open
              </a>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
