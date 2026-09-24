export function hasOpenModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}
