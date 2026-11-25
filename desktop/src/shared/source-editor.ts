import { EditorPreset } from "proto-desktop-ts";

interface EditorOption {
  value: EditorPreset;
  label: string;
  openFile: string;
  openAtLine: string;
}

export const sourceEditors: EditorOption[] = [
  {
    value: EditorPreset.EMACS,
    label: "Emacs",
    openFile: "emacsclient --no-wait %file",
    openAtLine: "emacsclient --no-wait +%line %file",
  },
  {
    value: EditorPreset.MAC_VIM,
    label: "MacVim",
    openFile: "mvim --remote-silent %file",
    openAtLine: "mvim --remote-silent +%line %file",
  },
  {
    value: EditorPreset.VS_CODE,
    label: "VS Code",
    openFile: "code %file",
    openAtLine: "code -g %file:%line",
  },
  {
    value: EditorPreset.SUBLIME_TEXT,
    label: "Sublime Text",
    openFile: "subl %file",
    openAtLine: "subl %file:%line",
  },
  {
    value: EditorPreset.CURSOR,
    label: "Cursor",
    openFile: "cursor %file",
    openAtLine: "cursor -g %file:%line",
  },
  {
    value: EditorPreset.ZED,
    label: "Zed",
    openFile: "zed %file",
    openAtLine: "zed %file:%line",
  },
  {
    value: EditorPreset.BBEDIT,
    label: "BBEdit",
    openFile: "bbedit %file",
    openAtLine: "bbedit +%line %file",
  },
  {
    value: EditorPreset.NOVA,
    label: "Nova",
    openFile: "nova open %file",
    openAtLine: "nova open %file -l %line",
  },
  {
    value: EditorPreset.TEXTMATE,
    label: "TextMate",
    openFile: "mate %file",
    openAtLine: "mate -l %line %file",
  },
];
