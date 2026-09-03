"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import MindMapView from "@/components/MindMapView";
import { studioTool, type StudioTool, type StudioToolKind, type StudioLength } from "@/lib/studioOptions";
// Type-only: lib/autoDeliver pulls in Prisma and Puppeteer, so this must
// never become a value import or it drags the server bundle into the client.
import type { AutoDeliverResult } from "@/lib/autoDeliver";

type AssessmentSummary = { id: string; clientId: string | null; customerId: string; factCount: number; createdAt: string };
type Source = { sourceReport: string; fieldCount: number };
type ChatTurn = { role: "user" | "assistant"; text: string };
type ExtractResult = {
  fileName: string;
  ok: boolean;
  error?: string;
  template?: string;
  assessmentId?: string;
  clientName?: string | null;
  missingFields?: string[];
  redirectedFrom?: string | null;
};

// Finance is deliberately absent: the Financial Wealth Management report
// replaced it. That one has its own renderer and vendor reference tables, so
// it gets its own tile driven by ?variant=fwm rather than a theme.
const THEMES = [
  { value: "career", label: "Career" },
  { value: "relationship", label: "Relationship" },
] as const;

// Gemini-generated deliverables, each served as a standalone HTML page at
// /studio/<kind>/<assessmentId> (see lib/studioArtifacts.ts). Cached per
// client after the first generation — "Regenerate" in the preview forces a
// fresh one.
// Shown in an empty conversation so there's somewhere to start.
const SUGGESTIONS = [
  "Summarise this client in 3 bullet points",
  "What are their strongest traits?",
  "What should a coach watch out for?",
  "Explain their stress level in plain language",
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Answers come back as light markdown — answerClientQuestion() appends a
 * "Sources: [title](url)" line whenever Google Search grounding fires, so
 * rendering them as plain text shows citations as literal [title](url)
 * instead of links. Escapes first, then only turns `[text](http…)` into
 * anchors and `**text**` into bold; anything else stays literal, so a model
 * response can never inject markup.
 */
function richText(text: string): string {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, label: string, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Each Studio tool's glyph. Kept here rather than in studioOptions.ts so that
// module stays free of presentation concerns — the generator imports it
// server-side purely for prompt text.
const TOOL_ICONS: Record<string, React.ReactNode> = {
  "mind-map": (
    <>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M7 12h3l7-5M10 12l7 5" />
    </>
  ),
  "slide-deck": (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.6" />
      <path d="M12 16v4M8.5 20h7" />
    </>
  ),
  flashcards: (
    <>
      <rect x="3" y="7" width="13" height="13" rx="1.6" />
      <path d="M7 4h11a2 2 0 0 1 2 2v10" />
    </>
  ),
  quiz: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.1 2.4c-.6.2-1 .8-1 1.4v.3M12 17h.01" />
    </>
  ),
  infographic: (
    <>
      <path d="M3 20h18" />
      <rect x="5" y="11" width="3.4" height="6" rx="0.7" />
      <rect x="10.3" y="6" width="3.4" height="11" rx="0.7" />
      <rect x="15.6" y="13.5" width="3.4" height="3.5" rx="0.7" />
    </>
  ),
  "data-table": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.6" />
      <path d="M3 9.5h18M3 14.7h18M9.4 4v16" />
    </>
  ),
  overview: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8.5h6M9 12.5h6M9 16.5h3.5" />
    </>
  ),
  full: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13.5h6M9 17h4" />
    </>
  ),
  career: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5.2A2.2 2.2 0 0 1 11.2 3h1.6A2.2 2.2 0 0 1 15 5.2V7M3 12.5h18" />
    </>
  ),
  relationship: (
    <>
      <path d="M12 20.2S5.6 16 5.6 11.4A3.7 3.7 0 0 1 12 8.8a3.7 3.7 0 0 1 6.4 2.6c0 4.6-6.4 8.8-6.4 8.8z" />
    </>
  ),
  // Upward trend in a frame — a wealth report rather than the plain currency
  // mark used by the Finance theme tile, which is a different deliverable.
  fwm: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 15l3.2-3.4 2.4 2.2L17 9M17 9h-2.8M17 9v2.8" />
    </>
  ),
};

// tint = tile background, ink = icon + label. Deliberately muted: eleven
// saturated tiles side by side would turn the rail into a colour chart.
const TOOL_COLORS: Record<string, { tint: string; ink: string }> = {
  "mind-map": { tint: "#1b2333", ink: "#9db8e8" },
  "slide-deck": { tint: "#282616", ink: "#dcc36b" },
  flashcards: { tint: "#2a1d21", ink: "#e39aa5" },
  quiz: { tint: "#1b2333", ink: "#9db8e8" },
  infographic: { tint: "#291d28", ink: "#dc8cc4" },
  "data-table": { tint: "#1a2434", ink: "#7fb4e8" },
  overview: { tint: "#16261e", ink: "#7fd3a3" },
  full: { tint: "#28211a", ink: "#dfa671" },
  career: { tint: "#1a2434", ink: "#7fb4e8" },
  relationship: { tint: "#2a1d21", ink: "#e39aa5" },
  // Keeps the green the Finance tile used, since FWM took its place in the rail.
  fwm: { tint: "#16261e", ink: "#7fd3a3" },
};

function ToolTile({
  id,
  label,
  onClick,
  state,
}: {
  id: string;
  label: string;
  onClick: () => void;
  // Only the reports a customer can buy pass this. Undefined = not a
  // purchasable deliverable (Mind Map, Infographic), so it stays neutral
  // rather than being dimmed as "not purchased".
  state?: "purchased" | "sent" | "none";
}) {
  const c = TOOL_COLORS[id] ?? { tint: "#1b2333", ink: "#9db8e8" };
  return (
    <button
      className={`tool-tile${state === "none" ? " tool-tile-idle" : ""}`}
      onClick={onClick}
      style={{ ["--tint" as string]: c.tint, ["--ink" as string]: c.ink } as React.CSSProperties}
    >
      <span className="tool-row">
        <svg className="tool-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          {TOOL_ICONS[id]}
        </svg>
        <svg className="tool-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </span>
      <span className="tool-name">{label}</span>
      {state === "purchased" && <span className="tool-badge">Purchased</span>}
      {state === "sent" && <span className="tool-badge tool-badge-sent">✓ Sent</span>}
    </button>
  );
}

function WorkspaceView() {
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get("id") ?? "";
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [selectedId, setSelectedId] = useState(deepLinkId);

  const [sources, setSources] = useState<Source[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [sourcesError, setSourcesError] = useState("");
  // Copying an earlier round's facts into this empty one (see
  // /api/assessments/[id]/copy-facts) — which round was picked, and whether
  // the copy is in flight.
  const [copyFrom, setCopyFrom] = useState("");
  const [copyingFacts, setCopyingFacts] = useState(false);
  const [copyError, setCopyError] = useState("");

  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadResults, setUploadResults] = useState<ExtractResult[]>([]);
  // Off by default — an upload for an existing client normally corrects
  // their current round (fixing a bad extraction shouldn't fork history).
  // Staff check this only when the upload is genuinely a new round (e.g. a
  // manually re-administered assessment outside the Quantemo purchase flow).
  const [newRound, setNewRound] = useState(false);
  // Outcome of the automatic post-upload send (see /api/auto-deliver). Shown
  // in the upload results rather than left silent: the whole point is that
  // nobody clicked Deliver, so this is the only place staff find out a report
  // reached the customer — or that it was held back over a gap.
  const [autoDeliver, setAutoDeliver] = useState<AutoDeliverResult | null>(null);
  const [autoDelivering, setAutoDelivering] = useState(false);

  // Sending the report to Quantemo is the one action here that writes to a
  // customer's account rather than to EmoWave's own data, so it reports its
  // outcome inline instead of silently succeeding.
  const [delivering, setDelivering] = useState(false);
  const [deliverResult, setDeliverResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Report slugs already sent to the customer for the selected round, so the
  // button can say "Sent" up front instead of only after a refused request.
  const [deliveredSlugs, setDeliveredSlugs] = useState<Set<string>>(new Set());
  const [deliveries, setDeliveries] = useState<{ variant: string; at: string }[]>([]);
  // What this round's owner actually paid for — one entry per Quantemo order.
  const [purchases, setPurchases] = useState<{ slug: string; orderId: number; at: string }[]>([]);
  // Count of orders the last auto-sync pulled in, so a purchase made while
  // this page is open announces itself instead of appearing silently.
  const [autoImported, setAutoImported] = useState(0);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [creatingClient, setCreatingClient] = useState(false);
  const [newClientError, setNewClientError] = useState("");

  const [showExtractModal, setShowExtractModal] = useState(false);
  // "pdf" gets a Download button (a real file); "page" is a live HTML view
  // "pdf" iframes a generated PDF (has a Download button). "mindmap" renders
  // the MindMapView component directly instead of iframing the standalone
  // /admin/mind-map page — avoids showing that page's own nav bar a second
  // time nested inside this modal's own chrome.
  // "page" is a live HTML view (the Studio artifacts) — iframed like a PDF,
  // but with Regenerate instead of Download, since it's generated content
  // rather than a file.
  const [preview, setPreview] = useState<{ url: string; label: string; kind: "pdf" | "mindmap" | "page"; topic?: string; warnings?: string[] } | null>(
    null,
  );

  // PDF reports go through this instead of setPreview directly — checks for
  // known data gaps (e.g. "no Journey Overview data") first, via the fast
  // non-rendering /check endpoint, so a warning banner is already there the
  // moment the preview opens, rather than the gap only being noticeable by
  // reading through the whole PDF.
  async function openReportPreview(baseUrl: string, label: string) {
    // Every open gets its own cache-buster — without this, reopening the
    // same report (same assessmentId/variant/theme) reuses an identical URL,
    // and the browser is free to serve a stale cached PDF for it even with
    // Cache-Control: no-store on the server, since some browsers/proxies
    // still short-circuit on a plain byte-for-byte URL match for iframe
    // navigations. A guaranteed-unique URL removes that ambiguity entirely.
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    setPreview({ url, label, kind: "pdf" });
    if (!selectedId) return;
    try {
      const res = await fetch(`/api/generate-report/check?assessmentId=${selectedId}`);
      const data = await res.json();
      if (res.ok) setPreview((p) => (p && p.url === url ? { ...p, warnings: data.warnings } : p));
    } catch {
      // Non-critical — the preview itself still works without the warning banner.
    }
  }

  // Every generated tool (Mind Map + Infographic) goes through this dialog
  // first, so staff choose format/length/focus BEFORE a Gemini call is
  // spent — the deterministic PDF renders skip it, they have nothing to
  // customise.
  const [configure, setConfigure] = useState<StudioTool | null>(null);
  const [cfgFormat, setCfgFormat] = useState("");
  const [cfgLength, setCfgLength] = useState<StudioLength>("default");
  const [cfgTopic, setCfgTopic] = useState("");

  function openConfigure(kind: StudioToolKind) {
    const tool = studioTool(kind);
    if (!tool) return;
    setCfgFormat(tool.formats[0]?.value ?? "");
    setCfgLength("default");
    setCfgTopic("");
    setConfigure(tool);
  }

  function generateConfigured() {
    if (!configure || !selectedId) return;
    const tool = configure;
    setConfigure(null);

    if (tool.kind === "mind-map") {
      // MindMapView fetches for itself, so the topic rides along as a prop
      // rather than in a URL the way the iframed artifacts do.
      setPreview({ url: selectedId, label: tool.label, kind: "mindmap", topic: cfgTopic.trim() || undefined });
      return;
    }

    const params = new URLSearchParams();
    if (cfgFormat) params.set("format", cfgFormat);
    if (tool.hasLength && cfgLength !== "default") params.set("length", cfgLength);
    if (cfgTopic.trim()) params.set("topic", cfgTopic.trim());
    const qs = params.toString();
    setPreview({ url: `/studio/${tool.kind}/${selectedId}${qs ? `?${qs}` : ""}`, label: tool.label, kind: "page" });
  }

  function closeNewClient() {
    setShowNewClient(false);
    setNewClientName("");
    setNewClientEmail("");
    setNewClientError("");
  }

  async function handleCreateClient(e: React.FormEvent) {
    e.preventDefault();
    const name = newClientName.trim();
    if (!name || creatingClient) return;
    setCreatingClient(true);
    setNewClientError("");
    try {
      const res = await fetch("/api/assessments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email: newClientEmail.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A 409 means this client already exists — the useful thing to do is
        // select the one they meant rather than making them hunt for it.
        if (res.status === 409 && data.assessmentId) {
          await loadAssessments(data.assessmentId);
          closeNewClient();
          return;
        }
        setNewClientError(data.error ?? `Could not create client (HTTP ${res.status}).`);
        return;
      }
      await loadAssessments(data.assessmentId);
      closeNewClient();
    } catch (err) {
      setNewClientError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setCreatingClient(false);
    }
  }

  function loadAssessments(selectAfter?: string) {
    return fetch("/api/assessments")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load clients (HTTP ${res.status}).`);
        return res.json();
      })
      .then((data) => {
        const list: AssessmentSummary[] = data.assessments ?? [];
        setAssessments(list);
        if (selectAfter) setSelectedId(selectAfter);
        else if (!selectedId && list.length > 0) setSelectedId(list[0].id);
      })
      .catch((err) => {
        // Surfaced through the same chatError banner rather than a
        // dedicated one — rare enough (a backend error, not a user
        // mistake) that a second error slot isn't worth the complexity.
        setChatError(err instanceof Error ? err.message : "Failed to load clients.");
      });
  }

  useEffect(() => {
    loadAssessments();
  }, []);

  function loadSources(id: string) {
    setLoadingSources(true);
    setSourcesError("");
    fetch(`/api/workspace/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load sources (HTTP ${res.status}) — try again, or reload the page.`);
        return res.json();
      })
      .then((data) => setSources(data.sources ?? []))
      .catch((err) => setSourcesError(err instanceof Error ? err.message : "Failed to load sources."))
      .finally(() => setLoadingSources(false));
  }

  useEffect(() => {
    setTurns([]);
    setChatError("");
    setCopyFrom("");
    setCopyError("");
    if (selectedId) loadSources(selectedId);
    else setSources([]);
  }, [selectedId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // Grow the composer to fit what's typed, up to a cap — past that it scrolls
  // rather than eating the conversation above it.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  // Escape closes whichever modal is open, and the page behind it shouldn't
  // scroll while one is. Both only apply while a modal is actually mounted.
  const modalOpen = showExtractModal || !!preview || !!configure || showNewClient;
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowExtractModal(false);
        setPreview(null);
        setConfigure(null);
        closeNewClient();
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [modalOpen]);

  // Uploading here works exactly like the standalone Extract page — a PDF's
  // client name gets matched against existing assessments (including the
  // one currently selected), so adding a new source for the same person
  // merges into this same record instead of creating a duplicate.
  async function handleUpload() {
    if (files.length === 0) return;
    setUploading(true);
    setUploadResults([]);
    setAutoDeliver(null);
    setUploadProgress({ done: 0, total: files.length });

    const collected: ExtractResult[] = [];
    let lastAssessmentId: string | undefined;
    // Only the FIRST file in a "new round" batch actually forces a new round
    // — the rest join whatever that first file just created. Without this, a
    // 3-file batch (Aquera + Emotional Notes + iEmoWave) checked as "new
    // round" would fork into three separate rounds instead of one, since
    // each upload independently sees itself as the latest existing round by
    // the time it's processed.
    let remainingForcesNewRound = newRound;
    // Which round this upload should join/correct — starts as whatever's
    // currently open in the Workspace, and if this batch creates a new round
    // (file 1), updates so files 2+ join THAT new round instead of the old
    // one. Sending this explicitly is what makes a correction land on the
    // round you're actually looking at, rather than the server guessing
    // "whichever round is newest for this name" and getting it wrong when
    // you're viewing an older one.
    let uploadTarget = selectedId;
    for (const file of files) {
      const formData = new FormData();
      formData.append("pdf", file);
      formData.append("newRound", String(remainingForcesNewRound));
      if (uploadTarget) formData.append("targetAssessmentId", uploadTarget);
      remainingForcesNewRound = false;
      try {
        const res = await fetch("/api/extract-facts", { method: "POST", body: formData });
        const data = await res.json();
        collected.push({ fileName: file.name, ok: res.ok, ...data });
        if (res.ok && data.assessmentId) {
          lastAssessmentId = data.assessmentId;
          uploadTarget = data.assessmentId;
        }
      } catch (e) {
        collected.push({ fileName: file.name, ok: false, error: e instanceof Error ? e.message : "Network error." });
      }
      setUploadResults([...collected]);
      setUploadProgress((p) => (p ? { done: p.done + 1, total: p.total } : null));
    }

    setUploading(false);
    setUploadProgress(null);
    setFiles([]);
    setNewRound(false);
    await loadAssessments(lastAssessmentId ?? selectedId);
    if (lastAssessmentId) loadSources(lastAssessmentId);

    // The batch is extracted — now send whatever this round's customer paid
    // for, without anyone clicking Deliver. Runs here rather than inside
    // /api/extract-facts so the gap check sees the COMPLETE round: per-file,
    // a three-source round would be judged on the first file alone.
    //
    // Only for a round that actually took data. A batch where every file
    // failed changed nothing, so there's nothing new to send.
    const target = lastAssessmentId ?? selectedId;
    if (target && collected.some((r) => r.ok)) await runAutoDeliver(target);
  }

  /**
   * Asks /api/auto-deliver to send whatever this round's customer paid for.
   *
   * Shared by both paths that can complete a round: finishing an upload
   * batch, and copying an earlier round's facts onto an empty one. The copy
   * path matters as much as the upload — a repeat purchase arrives empty and
   * is filled by copying, never by uploading, so leaving it out meant the
   * automatic send simply never fired for the most common case it was built
   * for.
   */
  /**
   * The outcome of an automatic send, rendered wherever one can be triggered
   * from — the upload modal and the Sources panel's copy control. Shared
   * because nobody clicked Deliver, so whichever surface the staff member is
   * looking at is the only place they find out a report reached a customer.
   */
  function autoDeliverBanner() {
    if (autoDelivering)
      return (
        <p className="doc-meta" style={{ marginTop: 12 }}>
          Checking what this customer has paid for…
        </p>
      );
    if (!autoDeliver) return null;
    return (
      <div style={{ marginTop: 12 }}>
        {autoDeliver.outcomes
          .filter((o) => o.status === "sent")
          .map((o) => (
            <p key={o.slug} className="doc-meta" style={{ margin: "2px 0", color: "var(--success)" }}>
              ✓ Sent {REPORT_LABELS[o.slug] ?? o.slug} to the customer&apos;s My Reports — no click needed.
            </p>
          ))}
        {autoDeliver.outcomes
          .filter((o) => o.status === "failed")
          .map((o) => (
            <p key={o.slug} className="doc-meta" style={{ margin: "2px 0", color: "var(--danger)" }}>
              ⚠ Couldn&apos;t send {REPORT_LABELS[o.slug] ?? o.slug}: {"reason" in o ? o.reason : ""} — send it by hand.
            </p>
          ))}
        {/* Gaps are the deliberate stop. Listing them rather than just saying
            "held back" means the fix is visible without opening a preview. */}
        {autoDeliver.warnings.length > 0 && (
          <>
            <p className="doc-meta" style={{ margin: "2px 0", color: "var(--warning, #d9832b)" }}>
              ⚠ Not sent automatically — {autoDeliver.reason}
            </p>
            {autoDeliver.warnings.map((w, i) => (
              <p key={i} className="doc-meta" style={{ margin: "2px 0 2px 14px", color: "var(--warning, #d9832b)" }}>
                • {w}
              </p>
            ))}
          </>
        )}
        {!autoDeliver.attempted && autoDeliver.warnings.length === 0 && (
          <p className="doc-meta" style={{ margin: "2px 0" }}>
            Nothing sent automatically — {autoDeliver.reason}
          </p>
        )}
      </div>
    );
  }

  async function runAutoDeliver(assessmentId: string) {
    setAutoDelivering(true);
    setAutoDeliver(null);
    try {
      const res = await fetch("/api/auto-deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assessmentId }),
      });
      const data = await res.json();
      setAutoDeliver(
        res.ok ? data : { attempted: false, reason: data.error ?? "Auto-delivery failed.", warnings: [], outcomes: [] },
      );
      // A send writes a delivered GeneratedReport row, which is what the
      // report tiles read to show "✓ Sent" — refresh so they don't keep
      // saying "Purchased" for something that just went out.
      if (data.outcomes?.some((o: { status: string }) => o.status === "sent")) loadDeliveries(assessmentId);
    } catch (err) {
      setAutoDeliver({
        attempted: false,
        reason: err instanceof Error ? err.message : "Auto-delivery failed.",
        warnings: [],
        outcomes: [],
      });
    } finally {
      setAutoDelivering(false);
    }
  }

  async function send() {
    const question = draft.trim();
    if (!question || sending || !selectedId) return;
    setDraft("");
    setChatError("");
    const nextTurns: ChatTurn[] = [...turns, { role: "user", text: question }];
    setTurns(nextTurns);
    setSending(true);
    try {
      const res = await fetch(`/api/workspace/${selectedId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: turns }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to get an answer.");
      setTurns([...nextTurns, { role: "assistant", text: data.answer }]);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Failed to get an answer.");
    } finally {
      setSending(false);
    }
  }

  const selected = assessments.find((a) => a.id === selectedId);

  // Groups every round under its client so the picker reads as "one person,
  // N versions" instead of a flat list of disconnected IDs — the only way to
  // tell rounds apart before this was the raw assessment id. Rounds with no
  // clientId (legacy/unlinked) each get their own single-round group keyed
  // by their own id, since there's nothing to group them with. Oldest first
  // within a group so "v1" really is the first one ever taken.
  const clientGroups = useMemo(() => {
    const groups = new Map<string, AssessmentSummary[]>();
    for (const a of assessments) {
      const key = a.clientId ?? `solo-${a.id}`;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    return [...groups.values()]
      .map((list) => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      .sort((a, b) => b[b.length - 1].createdAt.localeCompare(a[a.length - 1].createdAt));
  }, [assessments]);

  // Every round for whichever client is currently selected, newest first —
  // drives the version-switcher list in the Sources panel. null (rather
  // than a 1-item array) when this client only has the one round, since
  // there's nothing to switch between.
  const selectedGroup = (() => {
    if (!selected) return null;
    const group = clientGroups.find((g) => g.some((a) => a.id === selected.id));
    if (!group || group.length < 2) return null;
    return [...group].reverse(); // oldest-first storage -> newest-first display
  })();

  // Every round anywhere that carries facts — this client's first, then
  // everyone else's. Cross-client copying is allowed (the API takes an
  // explicit crossClient flag for it), but a borrowed round is invisible
  // afterwards, so the same-client candidates are grouped and offered first
  // rather than being buried alphabetically among other people's.
  const factSourceRounds = (() => {
    if (!selected) return { own: [], others: [] };
    const withFacts = assessments
      .filter((a) => a.id !== selected.id && a.factCount > 0)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const sameClient = (a: AssessmentSummary) => !!selected.clientId && a.clientId === selected.clientId;
    return { own: withFacts.filter(sameClient), others: withFacts.filter((a) => !sameClient(a)) };
  })();
  const hasFactSources = factSourceRounds.own.length + factSourceRounds.others.length > 0;
  // Which of the two groups the picked round came from, so the confirm below
  // knows whether this is a cross-person copy without re-deriving it.
  const copyFromIsOtherClient = factSourceRounds.others.some((a) => a.id === copyFrom);

  // The version label the picker shows for a round ("v7"), so the copy
  // control speaks the same language as the switcher beside it rather than
  // exposing raw assessment ids.
  const roundLabel = (id: string) => {
    const group = clientGroups.find((g) => g.some((a) => a.id === id));
    if (!group) return "this round";
    return `v${group.findIndex((a) => a.id === id) + 1}`;
  };

  async function handleCopyFacts() {
    if (!selectedId || !copyFrom) return;

    // Both confirms happen BEFORE the request, so the flags the API demands
    // are only ever sent by someone who read what they mean. The API refuses
    // without them regardless — this is the human half of that contract.
    const sourceRound = assessments.find((a) => a.id === copyFrom);
    if (
      copyFromIsOtherClient &&
      !confirm(
        `"${sourceRound?.customerId ?? "That round"}" is a different client from "${selected?.customerId ?? "this one"}".\n\n` +
          "Their assessment data will be filed under this person and will look extracted, not borrowed — " +
          "including to the chat, to every report, and to automatic delivery.\n\nCopy anyway?",
      )
    )
      return;
    // Replacing destroys real extracted facts, which no upload brings back
    // without re-running extraction on the original PDFs.
    if (
      sources.length > 0 &&
      !confirm(`This round already has ${sources.reduce((n, s) => n + s.fieldCount, 0)} fields. Delete them and replace with the copy?`)
    )
      return;

    setCopyingFacts(true);
    setCopyError("");
    try {
      const res = await fetch(`/api/assessments/${selectedId}/copy-facts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: copyFrom, crossClient: copyFromIsOtherClient, replace: sources.length > 0 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Copy failed (HTTP ${res.status}).`);
      // Both lists move: the Sources panel gains the copied reports, and the
      // dropdown's own fact counts are what decide whether this control
      // should still be offered at all.
      loadSources(selectedId);
      loadAssessments();
      setCopyFrom("");
      setCopyingFacts(false);
      // The round is now complete by the same measure an upload leaves it, so
      // it gets the same automatic send. This is the path a repeat purchase
      // actually takes — it arrives empty and is filled by copying, not by
      // uploading — so without this the automatic send never fires for it.
      await runAutoDeliver(selectedId);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : "Copy failed.");
    } finally {
      setCopyingFacts(false);
    }
  }

  // "v2 of 3" for whatever round is currently open — null when that client
  // only has this one round, since a version count of "1 of 1" would just be
  // noise rather than useful context.
  const selectedVersionInfo = (() => {
    if (!selected || !selectedGroup) return null;
    const index = selectedGroup.findIndex((a) => a.id === selected.id);
    return { version: selectedGroup.length - index, total: selectedGroup.length, isLatest: index === 0 };
  })();


  // Auto-import. Quantemo's Supabase can't call a localhost URL, so instead of
  // waiting to be pushed, EmoWave pulls: once when the page opens and every
  // 60s while it stays open. Calling OUT works from anywhere, so purchases
  // arrive on their own with no deploy, tunnel or webhook. If the webhook is
  // set up later this keeps running harmlessly — importing is idempotent on
  // the order, so whichever gets there first wins and the other finds nothing.
  useEffect(() => {
    let stopped = false;
    async function sync() {
      try {
        const res = await fetch("/api/quantemo-orders/sync", { method: "POST" });
        const data = await res.json();
        if (stopped || !data?.imported) return;
        setAutoImported(data.imported);
        loadAssessments();
      } catch {
        // Offline or Quantemo unreachable — the next tick tries again.
      }
    }
    sync();
    const timer = setInterval(sync, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Named rather than inline in the effect below because an automatic send
  // has to be able to re-run it: the report tiles read this to decide
  // "Purchased" vs "✓ Sent", and after auto-delivery that answer has changed
  // without the selected round changing.
  function loadDeliveries(id: string) {
    fetch(`/api/deliver-report?assessmentId=${id}`)
      .then((r) => (r.ok ? r.json() : { delivered: [] }))
      .then((d) => {
        setDeliveredSlugs(new Set((d.delivered ?? []).map((x: { variant: string }) => x.variant)));
        setDeliveries(d.delivered ?? []);
        setPurchases(d.purchased ?? []);
      })
      .catch(() => {
        setDeliveredSlugs(new Set());
        setDeliveries([]);
        setPurchases([]);
      });
  }

  useEffect(() => {
    setDeliveredSlugs(new Set());
    setDeliverResult(null);
    if (!selectedId) return;
    loadDeliveries(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // theme wins over variant: "career"/"relationship" are themed EmoWave
  // reports, and each is its own deliverable rather than a flavour of "full".
  const REPORT_LABELS: Record<string, string> = {
    overview: "EmoWave Overview",
    full: "Full Report",
    fwm: "Financial",
    career: "Career",
    relationship: "Relationship",
  };

  /**
   * Sent beats purchased: once it's with the customer, "have they paid?" is
   * answered and the useful question becomes whether anything is outstanding.
   * A report sent without a matching purchase (goodwill copy, mis-ordered
   * product) still reads as Sent — it did go out.
   */
  function tileState(slug: string): "purchased" | "sent" | "none" {
    const latestBuy = purchases.filter((p) => p.slug === slug).map((p) => p.at).sort().pop();
    const latestSend = deliveries.filter((d) => d.variant === slug).map((d) => d.at).sort().pop();
    if (!latestBuy) return latestSend ? "sent" : "none";
    // Bought again since it was last sent = owed again. Comparing timestamps
    // rather than just "has it ever been delivered" is what makes a REPEAT
    // purchase of the same report visible; otherwise the tile would still
    // read Sent and the new order would look already handled.
    return !latestSend || latestBuy > latestSend ? "purchased" : "sent";
  }

  function slugForPreview(previewUrl: string): string {
    const params = new URLSearchParams(previewUrl.split("?")[1] ?? "");
    return params.get("theme") ?? params.get("variant") ?? "full";
  }

  async function deliverToQuantemo(previewUrl: string) {
    if (!selectedId) return;
    // ?variant=/&theme= are exactly what /api/generate-report rendered, so
    // reusing them guarantees the delivered PDF matches the preview.
    const params = new URLSearchParams(previewUrl.split("?")[1] ?? "");
    const slug = slugForPreview(previewUrl);
    // Already sent is refused server-side; asking here turns that refusal
    // into a decision rather than an error the staff member has to interpret.
    const resend = deliveredSlugs.has(slug);
    if (resend && !confirm("This report has already been sent to the customer. Send it again and replace their copy?")) return;
    // Sending an unpurchased report isn't blocked — staff legitimately send
    // goodwill copies and fix mis-ordered products — but it shouldn't happen
    // by accident from having the wrong preview open.
    if (
      purchases.length > 0 &&
      !purchases.some((p) => p.slug === slug) &&
      !confirm(
        `This customer bought ${purchases.map((p) => REPORT_LABELS[p.slug] ?? p.slug).join(", ")}, not ${REPORT_LABELS[slug] ?? slug}. Send it anyway?`,
      )
    )
      return;
    setDelivering(true);
    setDeliverResult(null);
    try {
      const res = await fetch("/api/deliver-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessmentId: selectedId,
          variant: params.get("variant") ?? "full",
          theme: params.get("theme") ?? undefined,
          resend,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delivery failed.");
      setDeliveredSlugs((prev) => new Set(prev).add(slug));
      setDeliverResult({
        ok: true,
        message: data.created ? "Sent — it's now in the buyer's My Reports." : "Updated the copy in the buyer's My Reports.",
      });
    } catch (err) {
      setDeliverResult({ ok: false, message: err instanceof Error ? err.message : "Delivery failed." });
    } finally {
      setDelivering(false);
    }
  }

  return (
    <div className="container wide">
      <h1>EmoSpace</h1>
      <p className="subtitle" style={{ marginBottom: 18 }}>
        Everything for one client in one place — pick or create a client below, then upload, chat, and generate reports without leaving
        this page.
      </p>

      <div className="card">
        <label htmlFor="client-select">Client</label>
        <div className="uploader" style={{ marginTop: 6 }}>
          {/* One row per PERSON, not per round — picking a person always lands
              on their latest round; older rounds are switched to from the
              version list in the Sources panel instead, so this list doesn't
              balloon into 3 near-identical rows per repeat client. */}
          <select
            id="client-select"
            value={selectedGroup ? selectedGroup[0].id : selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">— Select a client —</option>
            {clientGroups.map((group) => {
              const latest = group[group.length - 1];
              return (
                <option
                  key={latest.id}
                  value={latest.id}
                  // Just the name (plus a round count for repeat clients) —
                  // names are what staff actually recognise, and an id/fact
                  // count beside every row was noise. The real assessment id
                  // is still what report URLs and log lines refer to, so it
                  // stays reachable on hover rather than disappearing.
                  title={`Assessment #${latest.id}`}
                >
                  {latest.customerId}
                  {group.length > 1 ? ` · ${group.length} rounds` : ""}
                </option>
              );
            })}
          </select>
          <button className="btn-secondary" onClick={() => setShowNewClient(true)} style={{ whiteSpace: "nowrap" }}>
            + New client
          </button>
        </div>
        {autoImported > 0 && (
          // Purchases can arrive while staff are mid-task; saying so is the
          // difference between "the list changed" and "someone just bought".
          <p className="saved" style={{ display: "inline-block", marginTop: 10 }}>
            ✓ {autoImported} new purchase{autoImported === 1 ? "" : "s"} imported from Quantemo
          </p>
        )}
      </div>

      <div className="workspace-grid">
        {/* Sources */}
        <div className="card">
          <div className="panel-title">
            Sources
            {sources.length > 0 && <span className="panel-count">{sources.length}</span>}
            {selectedGroup && (
              // Right in the header, not buried below the source list — this
              // IS the version picker: switching it changes sources, chat,
              // and which round every Studio tile generates a report from.
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                title="Switch which round of this client you're viewing"
                // Short labels on purpose — the full date and "current" are
                // still there as each <option>'s title tooltip, but the
                // closed select has to fit next to the "Sources" title
                // itself in this narrow sidebar card; even "v2 · current"
                // clipped against the card edge at any reasonable width
                // (confirmed by rendering this exact markup), so "current"
                // is a star instead of a word.
                style={{ marginLeft: "auto", fontSize: 12, padding: "2px 4px", maxWidth: 90, minWidth: 0 }}
              >
                {selectedGroup.map((a, i) => (
                  <option
                    key={a.id}
                    value={a.id}
                    title={`${new Date(a.createdAt).toLocaleDateString()}${i === 0 ? " (current)" : ""}`}
                  >
                    v{selectedGroup.length - i}
                    {i === 0 ? " ★" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button className="btn-secondary" style={{ width: "100%", marginBottom: 12 }} onClick={() => setShowExtractModal(true)}>
            + Add source
          </button>
          {!selectedId && <p className="empty">Add a source above to create a new client, or select one from the dropdown.</p>}
          {selectedId && loadingSources && <p className="empty">Loading…</p>}
          {selectedId && !loadingSources && sourcesError && (
            <p className="error">
              ⚠ {sourcesError}{" "}
              <button className="btn-secondary" onClick={() => loadSources(selectedId)} style={{ marginLeft: 6 }}>
                Retry
              </button>
            </p>
          )}
          {selectedId && !loadingSources && !sourcesError && sources.length === 0 && (
            <p className="empty">No sources yet — add one above.</p>
          )}
          {selectedId &&
            !loadingSources &&
            !sourcesError &&
            sources.map((s) => (
              <div key={s.sourceReport} className="source-row">
                <div className="source-name">{s.sourceReport}</div>
                <div className="doc-meta" style={{ marginBottom: 0 }}>
                  {s.fieldCount} fields
                </div>
              </div>
            ))}
          {/* Offered on every round, not just an empty one: a repeat purchase
              arrives empty and wants the earlier round's facts, but staff also
              need to replace a bad extraction without re-uploading. On a round
              that already has sources this REPLACES them, which is why the
              button says so and handleCopyFacts confirms twice. */}
          {selectedId && !loadingSources && !sourcesError && hasFactSources && (
            <div className="copy-facts">
              <p className="copy-facts-lead">
                {sources.length > 0 ? "Or replace these with another round’s facts:" : "Or reuse an earlier round’s facts:"}
              </p>
              <div className="copy-facts-row">
                <select
                  value={copyFrom}
                  onChange={(e) => setCopyFrom(e.target.value)}
                  disabled={copyingFacts}
                  aria-label="Round to copy facts from"
                >
                  <option value="">Choose a round…</option>
                  {/* Two groups rather than one flat list: same-person rounds
                      are the safe, ordinary case and other people's are the
                      exception, so the browser's own optgroup labelling is
                      what keeps them from being picked by accident. */}
                  {factSourceRounds.own.length > 0 && (
                    <optgroup label="This client">
                      {factSourceRounds.own.map((a) => (
                        <option key={a.id} value={a.id}>
                          {roundLabel(a.id)} · {a.factCount} facts · {new Date(a.createdAt).toLocaleDateString()}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {factSourceRounds.others.length > 0 && (
                    <optgroup label="Other clients — copies their data">
                      {factSourceRounds.others.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.customerId} · {a.factCount} facts · {new Date(a.createdAt).toLocaleDateString()}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button className="btn-secondary" onClick={handleCopyFacts} disabled={!copyFrom || copyingFacts}>
                  {copyingFacts ? "Copying…" : sources.length > 0 ? "Replace" : "Copy"}
                </button>
              </div>
              {/* Named before the click, not only inside the confirm dialog —
                  the whole risk of this control is that a borrowed round looks
                  identical to an extracted one once it lands. */}
              {copyFromIsOtherClient && (
                <p className="doc-meta" style={{ margin: "6px 0 0", color: "var(--warning, #d9832b)" }}>
                  ⚠ That round belongs to a different client. Their assessment data will be filed under{" "}
                  {selected?.customerId ?? "this client"} and won&rsquo;t be marked as borrowed.
                </p>
              )}
              {copyError && <p className="error">⚠ {copyError}</p>}
              {autoDeliverBanner()}
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="card chat-panel">
          <div className="panel-title">
            Chat
            {selected && <span className="panel-count">{selected.customerId}</span>}
            {selectedVersionInfo && (
              <span className="panel-count">
                v{selectedVersionInfo.version} of {selectedVersionInfo.total}
              </span>
            )}
          </div>
          {!selectedId ? (
            <p className="empty">Select or create a client to start chatting.</p>
          ) : (
            <>
              <div ref={scrollRef} className="chat-log">
                <div className="chat-stack">
                  {turns.length === 0 && !sending && (
                    <div>
                      <p className="chat-empty">Ask anything about {selected?.customerId ?? "this client"}&apos;s data.</p>
                      <div className="suggestions">
                        {SUGGESTIONS.map((s) => (
                          <button key={s} className="suggestion" onClick={() => setDraft(s)}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {turns.map((t, i) => {
                    // A rate-limit / failure notice comes back on the same
                    // channel as a real answer, so it's flagged by its leading
                    // warning glyph and styled as a notice, not as content.
                    const isNotice = t.role === "assistant" && t.text.startsWith("⚠");
                    return (
                      <div key={i} className={`msg ${t.role === "user" ? "msg-user" : "msg-assistant"}`}>
                        <div className="msg-head">
                          <span>{t.role === "user" ? "You" : isNotice ? "Notice" : "EmoWave AI"}</span>
                          {t.role === "assistant" && !isNotice && (
                            <button
                              className={`copy-btn${copiedIdx === i ? " done" : ""}`}
                              onClick={() => {
                                navigator.clipboard?.writeText(t.text);
                                setCopiedIdx(i);
                                window.setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
                              }}
                            >
                              {copiedIdx === i ? "✓ Copied" : "Copy"}
                            </button>
                          )}
                        </div>
                        <div
                          className={`bubble ${t.role === "user" ? "bubble-user" : isNotice ? "bubble-notice" : "bubble-assistant"}`}
                          dangerouslySetInnerHTML={{ __html: richText(t.text) }}
                        />
                      </div>
                    );
                  })}
                  {sending && (
                    <div className="typing" aria-label="Thinking">
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>
              </div>
              {chatError && <p className="error">⚠ {chatError}</p>}
              <div className="chat-composer">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
                  disabled={sending}
                  rows={1}
                />
                <button onClick={send} disabled={sending || !draft.trim()}>
                  Send
                </button>
              </div>
            </>
          )}
        </div>

        {/* Studio */}
        <div className="card">
          <div className="panel-title">Studio</div>
          {!selectedId ? (
            <p className="empty">Select or create a client to see generation tools.</p>
          ) : (
            <>
              {/* Reports (deterministic PDF renders) first, then the two
                  Gemini-generated tools — one combined grid, no Studio/Reports
                  split. */}
              <div className="studio-grid">
                <ToolTile
                  id="overview"
                  label="EmoWave"
                  state={tileState("overview")}
                  onClick={() =>
                    openReportPreview(`/api/generate-report?assessmentId=${selectedId}&variant=overview`, "EmoWave Overview (1 page)")
                  }
                />
                {/* Full Report is hidden from the Studio. Only this tile is
                    gone — /api/generate-report with no variant/theme still
                    renders it, and the themed tiles below depend on that same
                    endpoint, so nothing here is dead code. Restore by putting
                    the tile back:
                    <ToolTile id="full" label="Full Report" onClick={() => openReportPreview(`/api/generate-report?assessmentId=${selectedId}`, "Full Report")} /> */}
                {THEMES.map((t) => (
                  <ToolTile
                    key={t.value}
                    id={t.value}
                    label={t.label}
                    state={tileState(t.value)}
                    onClick={() => openReportPreview(`/api/generate-report?assessmentId=${selectedId}&theme=${t.value}`, `${t.label} Report`)}
                  />
                ))}
                {/* Its own report type with its own renderer and reference
                    tables, so it takes ?variant= rather than ?theme= like the
                    three tiles above. */}
                <ToolTile
                  id="fwm"
                  label="Financial"
                  state={tileState("fwm")}
                  onClick={() =>
                    openReportPreview(
                      `/api/generate-report?assessmentId=${selectedId}&variant=fwm`,
                      "Financial Wealth Management Report",
                    )
                  }
                />
                <ToolTile id="mind-map" label={studioTool("mind-map")?.label ?? "Mind Map"} onClick={() => openConfigure("mind-map")} />
                <ToolTile id="infographic" label={studioTool("infographic")?.label ?? "Infographic"} onClick={() => openConfigure("infographic")} />
              </div>

              <a href="/admin/facts" className="studio-link">
                Edit raw facts →
              </a>
              <a href="/admin/reports" className="studio-link">
                Edit report content (Gemini text) →
              </a>
            </>
          )}
        </div>
      </div>

      {showNewClient && (
        <div className="modal-overlay" onClick={closeNewClient} role="presentation">
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleCreateClient}
            className="card modal"
            style={{ width: "min(420px, 92vw)" }}
            aria-label="New client"
          >
            <div className="modal-head">
              <h3>New client</h3>
              <button type="button" className="btn-secondary" onClick={closeNewClient}>
                Close
              </button>
            </div>
            <p className="doc-meta" style={{ marginBottom: 14 }}>
              Creates an empty client you can upload reports for. Use the name exactly as it appears on their PDFs — an upload that
              reads the same name will merge into this client instead of creating a second one.
            </p>
            <label htmlFor="new-client-name">Client name</label>
            <input
              id="new-client-name"
              autoFocus
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              disabled={creatingClient}
              placeholder="e.g. Karen Anne Chalouhi"
              style={{ marginTop: 6 }}
            />
            <label htmlFor="new-client-email" style={{ marginTop: 12, display: "block" }}>
              Quantemo email <span style={{ color: "var(--faint)", fontWeight: 400 }}>(optional)</span>
            </label>
            <p className="doc-meta" style={{ margin: "2px 0 0" }}>
              Links this client to their Quantemo account, which is what lets repeat purchases stack up as rounds instead of
              separate clients. Leave blank to link later.
            </p>
            <input
              id="new-client-email"
              type="email"
              value={newClientEmail}
              onChange={(e) => setNewClientEmail(e.target.value)}
              disabled={creatingClient}
              placeholder="name@example.com"
              style={{ marginTop: 6 }}
            />
            {newClientError && (
              <p className="error" role="alert">
                ⚠ {newClientError}
              </p>
            )}
            <button type="submit" disabled={creatingClient || !newClientName.trim()} style={{ marginTop: 14 }}>
              {creatingClient ? "Creating…" : "Create client"}
            </button>
          </form>
        </div>
      )}

      {showExtractModal && (
        <div className="modal-overlay" onClick={() => setShowExtractModal(false)} role="presentation">
          <div
            onClick={(e) => e.stopPropagation()}
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-label="Add a source"
          >
            <div className="modal-head">
              <h3>Add source</h3>
              <button className="btn-secondary" onClick={() => setShowExtractModal(false)}>
                Close
              </button>
            </div>
            <p className="doc-meta" style={{ marginBottom: 14 }}>
              Upload a PDF for the currently selected client to add another source, or for a new client to create one — matched by the
              client&apos;s name on the PDF.
            </p>
            <div className="uploader">
              <input type="file" accept="application/pdf" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
              <button onClick={handleUpload} disabled={files.length === 0 || uploading}>
                {uploading ? `Extracting… ${uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : ""}` : "Upload & Extract"}
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13, color: "var(--text-soft, #9aa4b2)" }}>
              <input type="checkbox" checked={newRound} onChange={(e) => setNewRound(e.target.checked)} />
              This is a new report, not a correction — keep the current round untouched and start a fresh one
            </label>
            {uploadResults.length > 0 && !uploading && (
              <div style={{ marginTop: 14 }}>
                {uploadResults.map((r, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <p className="doc-meta" style={{ margin: 0, color: r.ok ? "var(--success)" : "var(--danger)" }}>
                      {r.fileName}: {r.ok ? `✓ ${r.template} → ${r.clientName ?? "assessment"} #${r.assessmentId}` : `⚠ ${r.error}`}
                    </p>
                    {/* A field the extractor recognizes but couldn't read (e.g. the Note
                        Balance chart image failing) used to only show up in a server log
                        or the saved .txt file — surfaced here instead, right where the
                        upload happened, so it's not discovered weeks later on the report. */}
                    {r.ok && r.missingFields && r.missingFields.length > 0 && (
                      <p className="doc-meta" style={{ margin: "2px 0 0", color: "var(--warning, #d9832b)" }}>
                        ⚠ Could not extract: {r.missingFields.join(", ")}
                      </p>
                    )}
                    {/* This file didn't actually belong to the client that was
                        open in Workspace — it got routed to the right one
                        automatically instead of being merged into the wrong
                        person's round, but that's worth calling out since it's
                        not where staff expected to be looking. */}
                    {r.ok && r.redirectedFrom && (
                      <p className="doc-meta" style={{ margin: "2px 0 0", color: "var(--warning, #d9832b)" }}>
                        ⚠ This PDF was for {r.clientName}, not {r.redirectedFrom} (who was open) — filed under {r.clientName} instead.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {autoDeliverBanner()}
          </div>
        </div>
      )}

      {configure && (
        <div className="modal-overlay" onClick={() => setConfigure(null)} role="presentation">
          <div
            onClick={(e) => e.stopPropagation()}
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Customise ${configure.label}`}
            style={{ width: "min(760px, 94vw)" }}
          >
            <div className="modal-head">
              <h3>Customise {configure.label}</h3>
              <button className="btn-secondary" onClick={() => setConfigure(null)}>
                Close
              </button>
            </div>

            {configure.formats.length > 0 && (
              <>
                <div className="cfg-label">Format</div>
                <div className="cfg-formats">
                  {configure.formats.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      className={`cfg-format${cfgFormat === f.value ? " selected" : ""}`}
                      aria-pressed={cfgFormat === f.value}
                      onClick={() => setCfgFormat(f.value)}
                    >
                      <span className="cfg-format-name">
                        {f.label}
                        {cfgFormat === f.value && <span aria-hidden="true"> ✓</span>}
                      </span>
                      <span className="cfg-format-desc">{f.description}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {configure.hasLength && (
              <>
                <div className="cfg-label">Length</div>
                <div className="cfg-lengths">
                  {(["short", "default", "long"] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      className={`cfg-length${cfgLength === l ? " selected" : ""}`}
                      aria-pressed={cfgLength === l}
                      onClick={() => setCfgLength(l)}
                    >
                      {l === "default" ? "Default" : l === "short" ? "Short" : "Long"}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="cfg-label">
              {configure.kind === "mind-map" ? "What should the map focus on?" : `What should this ${configure.label.toLowerCase()} focus on?`}
            </div>
            <textarea
              value={cfgTopic}
              onChange={(e) => setCfgTopic(e.target.value)}
              rows={3}
              placeholder={configure.topicPlaceholder}
              style={{ width: "100%", padding: "0.6rem", fontFamily: "inherit" }}
            />
            <div className="cfg-chips">
              {configure.suggestions.map((s) => (
                // Appends rather than replaces, so two chips can be combined
                // with anything already typed.
                <button
                  key={s}
                  type="button"
                  className="cfg-chip"
                  onClick={() => setCfgTopic((prev) => (prev.trim() ? `${prev.trim()}, ${s}` : s))}
                >
                  + {s}
                </button>
              ))}
            </div>

            <div className="cfg-actions">
              <span className="doc-meta">
                {configure.kind === "mind-map" || cfgTopic.trim() || cfgLength !== "default"
                  ? "Generates fresh — this doesn't reuse the cached version."
                  : "Uses the cached version if this client already has one."}
              </span>
              <button onClick={generateConfigured}>Generate</button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)} role="presentation">
          <div
            onClick={(e) => e.stopPropagation()}
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-label={preview.label}
            style={{ width: "min(900px, 92vw)", height: "88vh", display: "flex", flexDirection: "column" }}
          >
            <div className="modal-head">
              <h3>{preview.label}</h3>
              <div style={{ display: "flex", gap: 8 }}>
                {/* Sends whatever report is open, so the deliverable staff
                    just checked is the one the customer receives. Reads the
                    variant/theme back off the preview URL rather than tracking
                    them in state — the URL is already the single source of
                    truth for which report this is. */}
                {preview.kind === "pdf" && preview.url.startsWith("/api/generate-report") && (
                  <button className="btn-secondary" onClick={() => deliverToQuantemo(preview.url)} disabled={delivering}>
                    {delivering ? "Sending…" : deliveredSlugs.has(slugForPreview(preview.url)) ? "✓ Sent — send again?" : "Send to Quantemo"}
                  </button>
                )}
                {preview.kind === "pdf" && (
                  <a href={preview.url} download>
                    <button className="btn-secondary">Download</button>
                  </a>
                )}
                {preview.kind === "page" && (
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      // Keeps whatever the Customise dialog set (format,
                      // length, topic) — a regenerate should differ from the
                      // current view only in being freshly generated. Changing
                      // the src is what reloads the iframe, so the cache-buster
                      // matters as much as refresh=true: without it, clicking
                      // Regenerate twice wouldn't re-navigate.
                      const [path, search = ""] = preview.url.split("?");
                      const params = new URLSearchParams(search);
                      params.set("refresh", "true");
                      params.set("t", String(Date.now()));
                      setPreview({ ...preview, url: `${path}?${params.toString()}` });
                    }}
                  >
                    Regenerate
                  </button>
                )}
                <button className="btn-secondary" onClick={() => setPreview(null)}>
                  Close
                </button>
              </div>
            </div>
            {deliverResult && (
              <p className={deliverResult.ok ? "saved" : "error"} style={{ margin: "10px 0 0" }}>
                {deliverResult.ok ? "✓ " : "⚠ "}
                {deliverResult.message}
              </p>
            )}
            {preview.kind === "pdf" && preview.warnings && preview.warnings.length > 0 && (
              <div
                style={{
                  background: "var(--warning-soft, #fbe9d0)",
                  color: "var(--warning, #a15c1a)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  marginBottom: 8,
                  fontSize: 13,
                }}
              >
                <strong>⚠ Data gaps in this report:</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.kind === "mindmap" ? (
              <div style={{ flex: 1, overflowY: "auto" }}>
                <MindMapView assessmentId={preview.url} topic={preview.topic} />
              </div>
            ) : (
              <iframe src={preview.url} title={preview.label} style={{ flex: 1, width: "100%", border: "1px solid var(--border)", borderRadius: 8 }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// useSearchParams() opts a page out of static prerendering unless it sits
// under a Suspense boundary — without one, `next build` fails the whole
// export rather than degrading. The boundary is what lets Next ship the
// static shell and fill the URL-dependent part in on the client.
export default function WorkspacePage() {
  return (
    <Suspense fallback={<p className="empty">Loading EmoSpace…</p>}>
      <WorkspaceView />
    </Suspense>
  );
}
