export function modelDisplayName(name: string | undefined, id: string): string {
  return name?.trim() || id;
}
