import { EditIcon, FilesIcon } from "../ClipboardIcons";
import type { AgentToolIconKind } from "./tool-presentation";

const paths = {
  search: "M7 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm3-1 3 3",
  terminal: "M2 3h12v10H2zM4 6l2 2-2 2M8 10h3",
  tools: "m8 2 6 3-6 3-6-3 6-3ZM2 8l6 3 6-3M2 11l6 3 6-3",
};

export function AgentToolIcon({ kind }: { kind: AgentToolIconKind }) {
  return (
    <span className="agent-tool-icon" data-icon={kind} aria-hidden="true">
      {kind === "file" ? (
        <FilesIcon size={14} />
      ) : kind === "edit" ? (
        <EditIcon />
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={paths[kind]} />
        </svg>
      )}
    </span>
  );
}
