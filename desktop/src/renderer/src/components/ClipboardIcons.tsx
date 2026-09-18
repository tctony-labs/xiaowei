export function StarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5l1.76 3.57 3.94.57-2.85 2.78.67 3.93L8 10.52 4.48 12.35l.67-3.93-2.85-2.78 3.94-.57z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClipIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="2.5" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 2.5V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5.5 6.5h5M5.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function ImageIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1" />
      <path d="M1.5 10.5l3.5-3 3 2.5 2-1.5 4.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function FilesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5V12a1.5 1.5 0 001.5 1.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <rect x="4.5" y="2" width="9" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function TagIcon({ size = 16, color }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5h4.59a1 1 0 01.7.29l5.71 5.71a1 1 0 010 1.41l-3.59 3.59a1 1 0 01-1.41 0L2.79 8.79a1 1 0 01-.29-.7V3.5z"
        stroke={color || "currentColor"}
        strokeWidth="1.2"
      />
      <circle cx="5.5" cy="6.5" r="1" fill={color || "currentColor"} />
    </svg>
  );
}

export function AddCircleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M8.5 2.5l3 3M2 9l6.5-6.5 3 3L5 12H2V9z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M3.5 5h11M6 5V4a1.5 1.5 0 011.5-1.5h3A1.5 1.5 0 0112 4v1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M4.5 5l.7 9.5a1.5 1.5 0 001.5 1.5h4.6a1.5 1.5 0 001.5-1.5L13.5 5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M7 8v4M9 8v4M11 8v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function RemarkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M4 3h10a1 1 0 011 1v8a1 1 0 01-1 1H8l-3 2.5V13H4a1 1 0 01-1-1V4a1 1 0 011-1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M6.5 7h5M6.5 9.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function TextEditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M11.06 3.94a1.5 1.5 0 012.12 0l.88.88a1.5 1.5 0 010 2.12L7.5 13.5 4 14.5l1-3.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M10 5l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function FavoriteIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M9 2.5l1.95 3.95 4.36.64-3.16 3.08.74 4.33L9 12.37l-3.89 2.13.74-4.33-3.16-3.08 4.36-.64z"
        fill={filled ? "#F1B007" : "none"}
        stroke={filled ? "#F1B007" : "currentColor"}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={`transition-transform ${collapsed ? "rotate-180" : ""}`}
    >
      <path d="M4 6l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" />
      <path d="M9.5 4.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5.5a1 1 0 001 1h1.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function OpenFileMenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 6h4v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 6L7 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function RevealMenuIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M3 7.5V5a1.5 1.5 0 011.5-1.5h3L9 5h4.5A1.5 1.5 0 0115 6.5V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.5 7.5h13l-1.5 7H4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
