"use client";

import { useEffect, useState } from "react";

export type MindMapBranch = { label: string; children: string[] };
export type MindMapData = { root: string; branches: MindMapBranch[] };

// A muted, richer palette that reads well against the app's dark surfaces
// (see --card/--border in globals.css) instead of the saturated colors that
// only work on a light background.
const BRANCH_COLORS = ["#a78bd6", "#6fa3e0", "#5fc2b0", "#8bc36f", "#e0c15c", "#e0a15c", "#e08a8a"];

const ROW_H = 36;
const BRANCH_GAP = 22;
const ROOT_X = 60;
const BRANCH_X = 350;
const CHILD_X = 640;
const CHILD_WIDTH = 280;

/**
 * Self-contained, interactive mind map — starts with just the root and
 * top-level branches showing (matching the reference NotebookLM UI), each
 * branch with a ">" toggle that reveals its children on click instead of
 * rendering the entire tree expanded at once. Fetches its own data (with
 * caching — see /api/mind-map/[assessmentId]) so it can be dropped into any
 * page or modal without that page needing to know about the fetch/cache
 * logic itself.
 */
export default function MindMapView({ assessmentId, topic }: { assessmentId: string; topic?: string }) {
  const [customerName, setCustomerName] = useState("");
  const [mindMap, setMindMap] = useState<MindMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [regenerating, setRegenerating] = useState(false);

  function load(refresh = false) {
    setLoading(true);
    setError("");
    // The topic (set in the Studio's Customise dialog) has to ride along on
    // every load, including a Regenerate — dropping it there would silently
    // hand back a general map instead of the one that was asked for.
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "true");
    if (topic?.trim()) params.set("topic", topic.trim());
    const qs = params.toString();
    fetch(`/api/mind-map/${assessmentId}${qs ? `?${qs}` : ""}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to generate mind map.");
        setCustomerName(data.customerName);
        setMindMap(data.mindMap);
        setExpanded(new Set());
      })
      .catch((err) => setError(err.message))
      .finally(() => {
        setLoading(false);
        setRegenerating(false);
      });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentId, topic]);

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  if (loading) return <p className="empty">Generating…</p>;
  if (error) return <p className="error">⚠ {error}</p>;
  if (!mindMap) return null;

  let cursorY = 44;
  const branchLayout = mindMap.branches.map((branch, i) => {
    const isOpen = expanded.has(i);
    const h = isOpen ? Math.max(1, branch.children.length) * ROW_H : ROW_H;
    const top = cursorY;
    cursorY += h + BRANCH_GAP;
    return { branch, index: i, isOpen, color: BRANCH_COLORS[i % BRANCH_COLORS.length], top, centerY: top + h / 2, height: h };
  });
  const totalHeight = cursorY;
  const rootY = totalHeight / 2;
  const width = CHILD_X + CHILD_WIDTH + 40;
  const rootW = Math.max(160, mindMap.root.length * 9 + 50);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="btn-secondary" onClick={() => { setRegenerating(true); load(true); }} disabled={regenerating}>
          {regenerating ? "Regenerating…" : "Regenerate"}
        </button>
      </div>
      <svg
        viewBox={`0 0 ${width} ${totalHeight}`}
        width="100%"
        style={{ maxWidth: 1140, fontFamily: "system-ui, sans-serif" }}
        className="mindmap-svg-enter"
      >
        <defs>
          <linearGradient id="rootGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5b9dfb" />
            <stop offset="100%" stopColor="#8e6fd6" />
          </linearGradient>
          <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#000" floodOpacity="0.35" />
          </filter>
        </defs>

        {branchLayout.map((b) => (
          <path
            key={`root-line-${b.index}`}
            pathLength={1}
            className="mindmap-line-draw"
            style={{ animationDelay: `${120 + b.index * 60}ms` }}
            d={`M ${ROOT_X + rootW} ${rootY} C ${(ROOT_X + rootW + BRANCH_X) / 2} ${rootY}, ${(ROOT_X + rootW + BRANCH_X) / 2} ${b.centerY}, ${BRANCH_X - 4} ${b.centerY}`}
            fill="none"
            stroke={b.color}
            strokeWidth={2}
            opacity={0.55}
          />
        ))}
        {branchLayout
          .filter((b) => b.isOpen)
          .map((b) =>
            b.branch.children.map((child, ci) => {
              const cy = b.top + ci * ROW_H + ROW_H / 2;
              return (
                <path
                  key={`branch-line-${b.index}-${ci}`}
                  pathLength={1}
                  className="mindmap-line-draw"
                  style={{ animationDelay: `${ci * 40}ms` }}
                  d={`M ${BRANCH_X + 176} ${b.centerY} C ${(BRANCH_X + CHILD_X) / 2} ${b.centerY}, ${(BRANCH_X + CHILD_X) / 2} ${cy}, ${CHILD_X - 4} ${cy}`}
                  fill="none"
                  stroke={b.color}
                  strokeWidth={1.2}
                  opacity={0.35}
                />
              );
            }),
          )}

        <g className="mindmap-pop">
          <rect x={ROOT_X} y={rootY - 27} width={rootW} height={54} rx={27} fill="url(#rootGrad)" filter="url(#softShadow)" />
          <text x={ROOT_X + rootW / 2} y={rootY + 5} textAnchor="middle" fill="#fff" fontSize={15} fontWeight={700}>
            {mindMap.root}
          </text>
        </g>

        {branchLayout.map((b) => (
          <g key={`branch-${b.index}`}>
            <g
              className="mindmap-branch-tile mindmap-pop"
              style={{ cursor: "pointer", animationDelay: `${80 + b.index * 60}ms` }}
              onClick={() => toggle(b.index)}
            >
              <rect x={BRANCH_X} y={b.centerY - 20} width={176} height={40} rx={20} fill={b.color} filter="url(#softShadow)" />
              <text x={BRANCH_X + 82} y={b.centerY + 5} textAnchor="middle" fill="#12151f" fontSize={12.5} fontWeight={700}>
                {b.branch.label}
              </text>
              <text
                x={BRANCH_X + 158}
                y={b.centerY + 5}
                textAnchor="middle"
                fill="#12151f"
                fontSize={13}
                fontWeight={700}
                className={`mindmap-chevron${b.isOpen ? " mindmap-chevron-open" : ""}`}
              >
                ›
              </text>
            </g>
            {b.isOpen &&
              b.branch.children.map((child, ci) => {
                const cy = b.top + ci * ROW_H + ROW_H / 2;
                return (
                  <g key={`child-${b.index}-${ci}`} className="mindmap-child-enter" style={{ animationDelay: `${ci * 40}ms` }}>
                    <rect x={CHILD_X} y={cy - 15} width={CHILD_WIDTH} height={30} rx={8} fill="#171e2d" stroke={b.color} strokeWidth={1.3} opacity={0.95} />
                    <text x={CHILD_X + 14} y={cy + 4} fill="#e8ecf5" fontSize={11.5}>
                      {child.length > 48 ? child.slice(0, 47) + "…" : child}
                    </text>
                  </g>
                );
              })}
          </g>
        ))}
      </svg>
    </div>
  );
}
