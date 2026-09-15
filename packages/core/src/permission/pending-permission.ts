import type { PermissionRequest } from './permission-request.js';

/** conductor 判断待ちの permission 要求。 */
export interface PendingPermission {
  id: string;
  workerId: string;
  request: PermissionRequest;
  createdAt: number;
}

export class PendingPermissionRegistry {
  private readonly entries = new Map<string, PendingPermission>();

  add(entry: PendingPermission): void {
    this.entries.set(entry.id, entry);
  }

  get(id: string): PendingPermission | undefined {
    return this.entries.get(id);
  }

  list(): PendingPermission[] {
    return [...this.entries.values()];
  }

  take(id: string): PendingPermission | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    return entry;
  }

  takeForWorker(workerId: string): PendingPermission[] {
    const entries = this.list().filter((entry) => entry.workerId === workerId);
    for (const entry of entries) {
      this.entries.delete(entry.id);
    }
    return entries;
  }

  get size(): number {
    return this.entries.size;
  }
}
