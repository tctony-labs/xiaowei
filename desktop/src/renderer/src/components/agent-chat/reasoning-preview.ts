import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as markdownText } from "mdast-util-to-string";

function simpleTitle(text: string): string | undefined {
  let title: string | undefined;

  for (const block of fromMarkdown(text).children) {
    if (block.type !== "heading" && block.type !== "paragraph") return;

    const [first, ...rest] = block.children;
    const following = rest[0];

    // A bold title can share a paragraph with prose that starts on the next line.
    if (
      block.type === "paragraph" &&
      first?.type === "strong" &&
      first.position?.start.line === first.position?.end.line &&
      (!following || (following.type === "text" && /^[ \t]*\r?\n/.test(following.value)))
    ) {
      if (first.children.some((child) => child.type !== "text")) return;
      if (rest.some((child) => child.type !== "text")) return;
      title = markdownText(first).trim();
      continue;
    }

    if (block.children.some((child) => child.type !== "text")) return;
    if (block.type === "heading") title = markdownText(block).trim();
  }

  return title;
}

export function reasoningPreview(text: string): string {
  const content = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const title = simpleTitle(content);
  if (title) return title;

  for (const line of content.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    const preview = markdownText(fromMarkdown(line.trim()), { includeHtml: false }).trim();
    if (preview) return preview;
  }
  return "";
}
