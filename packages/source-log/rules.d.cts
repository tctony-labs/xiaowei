import type { NodePath } from "@babel/traverse";

export const runtime: string;
export function getSourcePath(file: string, workspaceRoot: string): string | null;
export function getLogCall(path: NodePath): {
  method: string;
  line: number;
  start: number;
  end: number;
  position: number;
} | null;
