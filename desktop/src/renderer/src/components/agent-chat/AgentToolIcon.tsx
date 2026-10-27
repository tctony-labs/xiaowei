import { EditIcon, FilesIcon } from "../ClipboardIcons";
import type { AgentToolIconKind } from "./tool-presentation";

const paths = {
  web: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM2 8h12M8 2c-4 3-4 9 0 12M8 2c4 3 4 9 0 12",
  todo: "m2 4 1 1 2-2M7 4h7M2 8h3M7 8h7M2 12h3M7 12h7",
  question: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM6 6a2 2 0 1 1 3 2c-1 .5-1 1-1 1M8 11h.01",
  permission: "M8 1.5 13 4v4c0 3-5 6.5-5 6.5S3 11 3 8V4l5-2.5ZM6 8l1.5 1.5L10 6",
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
