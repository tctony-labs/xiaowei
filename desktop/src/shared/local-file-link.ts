export function isLocalFileLink(href: string): boolean {
  return /^file:\/\//i.test(href) || /^\/(?!\/)/.test(href) || /^[a-z]:[/\\]/i.test(href);
}
