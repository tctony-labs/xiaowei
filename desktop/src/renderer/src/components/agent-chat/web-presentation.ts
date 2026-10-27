import { isToolObject, parseToolJson } from "./tool-presentation";

export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function readWebSearch(source: string | undefined) {
  const metadata = parseToolJson(source);
  const payload = isToolObject(metadata) ? metadata.webSearch : undefined;
  if (
    !isToolObject(payload) ||
    typeof payload.query !== "string" ||
    !Array.isArray(payload.results)
  )
    return undefined;
  const results = [];
  for (const result of payload.results) {
    if (
      !isToolObject(result) ||
      typeof result.title !== "string" ||
      typeof result.url !== "string" ||
      typeof result.snippet !== "string"
    )
      return undefined;
    results.push({ title: result.title, url: result.url, snippet: result.snippet });
  }
  return { query: payload.query, results };
}
