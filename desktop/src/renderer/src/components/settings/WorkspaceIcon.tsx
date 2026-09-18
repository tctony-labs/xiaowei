interface WorkspaceIconProps {
  isWiki: boolean;
  isHome: boolean;
  className?: string;
}

/** Workspace 标题前的 icon：wiki → 书/笔记本；home → 房子；其他普通工作区 → 文件夹。 */
export default function WorkspaceIcon({ isWiki, isHome, className }: WorkspaceIconProps) {
  const cls = className ?? "h-3.5 w-3.5 shrink-0";
  const common = {
    className: cls,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
  };
  if (isWiki) {
    return (
      <svg {...common} aria-label="wiki">
        <title>wiki</title>
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v17.5M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-2.5M4 19.5A2.5 2.5 0 0 1 6.5 17H20"
        />
      </svg>
    );
  }
  if (isHome) {
    return (
      <svg {...common} aria-label="home">
        <title>home</title>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 11l9-8 9 8M5 9.5V21h4v-6h6v6h4V9.5" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-label="folder">
      <title>folder</title>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
      />
    </svg>
  );
}
