import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type EditorPreference, EditorPreset } from "proto-desktop-ts";
import { isLocalFileLink } from "../../../shared/local-file-link";
import { sourceEditors } from "../../../shared/source-editor";

const runEditor = promisify(execFile);
const emacsEvalTemplate =
  /^[ \t]*((?:[\w./+-]+\/)?emacsclient[ \t]+(?:--eval|-e))[ \t]+'([^']*"%file"[^']*)'[ \t]*$/;

export async function resolveFileLink(href: string) {
  if (!isLocalFileLink(href)) throw new Error("Invalid local file link");

  const lineSuffix = /(?:#L|:)([1-9][0-9]*)$/.exec(href);
  const target = lineSuffix ? href.slice(0, lineSuffix.index) : href;
  const line = lineSuffix ? Number(lineSuffix[1]) : undefined;
  let path: string;
  if (/^file:\/\//i.test(target)) {
    const url = new URL(target);
    if (url.hostname && url.hostname !== "localhost") throw new Error("Invalid local file host");
    path = fileURLToPath(url);
  } else {
    path = decodeURIComponent(target);
  }

  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid local file path");
  if (line !== undefined && !Number.isSafeInteger(line)) throw new Error("Invalid source line");
  if (!(await stat(path)).isFile()) throw new Error("Local file link requires a file");
  return { path, line };
}

export async function openInSourceEditor(
  path: string,
  line: number | undefined,
  preference: EditorPreference | undefined,
): Promise<boolean> {
  const selected = preference?.selected ?? EditorPreset.SYSTEM;
  if (selected === EditorPreset.SYSTEM) {
    return false;
  }
  const editor =
    selected === EditorPreset.CUSTOM
      ? preference?.custom
      : sourceEditors.find(({ value }) => value === selected);
  if (!editor) throw new Error("Invalid source editor configuration");

  const template = line === undefined ? editor.openFile : editor.openAtLine;
  const lineValue = line?.toString() ?? "";
  const location = [path, lineValue];
  const emacsEval = emacsEvalTemplate.exec(template);
  // Expand positional parameters without splitting or globbing filenames. The path and
  // line stay outside the shell program, including when the path contains shell syntax.
  const script = emacsEval
    ? `${emacsEval[1]} "$3"`
    : template.replace(/%file|%line/g, (token) =>
        token === "%file" ? `\${xiaowei_editor_file}` : `\${xiaowei_editor_line}`,
      );
  if (emacsEval) {
    // Bind the complete Lisp argument after substituting the escaped string literal.
    location.push(
      emacsEval[2].replace(/"%file"|%line/g, (token) =>
        token === '"%file"' ? JSON.stringify(path) : lineValue,
      ),
    );
  }
  const initialization = [
    "unsetopt SH_WORD_SPLIT GLOB_SUBST",
    'readonly xiaowei_editor_file="$1" xiaowei_editor_line="$2"',
  ].join("\n");
  const env = {
    ...process.env,
    PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(delimiter),
  };
  try {
    await runEditor(
      "/bin/zsh",
      ["-ic", `${initialization}\n${script}`, "xiaowei-editor", ...location],
      { env },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.warn("Source editor launch failed", {
      editor: selected,
      code,
    });
    throw new Error("Source editor launch failed");
  }
  return true;
}
