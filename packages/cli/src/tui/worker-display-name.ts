export function formatWorkerDisplayName(name: string, kind: string): string {
  return name === kind ? name : `${name} (${kind})`;
}
