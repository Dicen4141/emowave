/**
 * Line icons for the Studio panel's tiles and rows.
 *
 * Drawn inline rather than pulled from an icon package: there are a dozen of
 * them, they all share one stroke style, and shipping a dependency for that
 * would cost more than the markup does. They inherit `currentColor`, which is
 * what lets each tile tint its own icon through --tile.
 */
type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function MindMapIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="2.4" />
      <circle cx="19" cy="6" r="2.4" />
      <circle cx="19" cy="18" r="2.4" />
      <path d="M7.4 12h3.6M11 12V7.2h5.6M11 12v4.8h5.6" />
    </svg>
  );
}

export function SlideDeckIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.8" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  );
}

export function FlashcardsIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="7" width="14" height="12" rx="1.8" />
      <path d="M7 7V5.4A1.4 1.4 0 0 1 8.4 4H19a2 2 0 0 1 2 2v9.6" />
    </svg>
  );
}

export function QuizIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 3.5V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
      <path d="M10 8.6a2 2 0 1 1 2.6 1.9c-.5.2-.8.7-.8 1.2v.4" />
      <path d="M11.8 14.4h.01" />
    </svg>
  );
}

export function InfographicIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M4 20V10M9.3 20V4M14.7 20v-7M20 20V7" />
    </svg>
  );
}

export function DataTableIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="1.8" />
      <path d="M3 9.5h18M9.5 9.5V20" />
    </svg>
  );
}

export function OverviewIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <rect x="4.5" y="3" width="15" height="18" rx="1.8" />
      <path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4" />
    </svg>
  );
}

export function ReportIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5M8.8 13h6.4M8.8 17h4.4" />
    </svg>
  );
}

export function ThemedIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 3l2.1 4.9 5.3.5-4 3.5 1.2 5.2L12 14.4 7.4 17.1l1.2-5.2-4-3.5 5.3-.5z" />
    </svg>
  );
}

export function NoteIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

export function ChevronIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M4 20h4L20 8a2.1 2.1 0 0 0-3-3L5 17z" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
