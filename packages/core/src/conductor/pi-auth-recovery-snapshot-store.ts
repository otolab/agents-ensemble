import type { ConductorRecoveryReportEvent } from './session/session-event.js';

export const PI_AUTH_RECOVERY_SNAPSHOT_LIMIT = 4;
export const PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS = 30 * 60 * 1_000;

export type PiAuthRecoverySnapshotCandidate = Pick<
  ConductorRecoveryReportEvent,
  'recoveryId' | 'failedDispatch' | 'failure'
>;

export interface PiAuthRecoverySnapshot {
  recoveryId: string;
  createdAt: number;
  expiresAt: number;
  failedDispatch: ConductorRecoveryReportEvent['failedDispatch'];
  failure: ConductorRecoveryReportEvent['failure'];
  content: string;
  contentBytes: number;
}

export interface PiAuthRecoverySnapshotSummary {
  recoveryId: string;
  createdAt: number;
  expiresAt: number;
  sendCount: number;
  sourceKey: string;
  eventTypes: string[];
  eventCount: number;
  contentBytes: number;
  automaticRetryAttempts: 0 | 1;
  toolCallStarted: boolean;
}

export interface PiAuthRecoverySnapshotStoreAddResult {
  snapshot: PiAuthRecoverySnapshotSummary;
  evictedRecoveryIds: string[];
}

interface StoredSnapshot {
  snapshot: PiAuthRecoverySnapshot;
  expiryTimer: ReturnType<typeof setTimeout>;
}

/** Final Pi resolver failures kept for explicit, local operator inspection. */
export class PiAuthRecoverySnapshotStore {
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private disposed = false;

  add(
    candidate: PiAuthRecoverySnapshotCandidate,
    content: string,
    now = Date.now(),
  ): PiAuthRecoverySnapshotStoreAddResult | undefined {
    if (this.disposed) {
      return undefined;
    }

    this.pruneExpired(now);
    this.remove(candidate.recoveryId);

    const evictedRecoveryIds: string[] = [];
    while (this.snapshots.size >= PI_AUTH_RECOVERY_SNAPSHOT_LIMIT) {
      const oldestRecoveryId = this.snapshots.keys().next().value as
        | string
        | undefined;
      if (oldestRecoveryId === undefined) {
        break;
      }
      this.remove(oldestRecoveryId);
      evictedRecoveryIds.push(oldestRecoveryId);
    }

    const snapshot: PiAuthRecoverySnapshot = {
      recoveryId: candidate.recoveryId,
      createdAt: now,
      expiresAt: now + PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS,
      failedDispatch: cloneFailedDispatch(candidate.failedDispatch),
      failure: { ...candidate.failure },
      content,
      contentBytes: Buffer.byteLength(content, 'utf8'),
    };
    const expiryTimer = setTimeout(() => {
      this.removeIfCurrent(snapshot.recoveryId, snapshot.expiresAt);
    }, PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS);
    expiryTimer.unref?.();
    this.snapshots.set(snapshot.recoveryId, { snapshot, expiryTimer });

    return {
      snapshot: summarizePiAuthRecoverySnapshot(snapshot),
      evictedRecoveryIds,
    };
  }

  list(now = Date.now()): PiAuthRecoverySnapshotSummary[] {
    this.pruneExpired(now);
    return [...this.snapshots.values()].map(({ snapshot }) =>
      summarizePiAuthRecoverySnapshot(snapshot),
    );
  }

  get(
    recoveryId: string,
    now = Date.now(),
  ): PiAuthRecoverySnapshot | undefined {
    this.pruneExpired(now);
    const snapshot = this.snapshots.get(recoveryId)?.snapshot;
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  remove(recoveryId: string): boolean {
    const entry = this.snapshots.get(recoveryId);
    if (!entry) {
      return false;
    }
    clearTimeout(entry.expiryTimer);
    this.snapshots.delete(recoveryId);
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of this.snapshots.values()) {
      clearTimeout(entry.expiryTimer);
    }
    this.snapshots.clear();
  }

  private pruneExpired(now: number): void {
    for (const [recoveryId, entry] of this.snapshots) {
      if (entry.snapshot.expiresAt <= now) {
        this.remove(recoveryId);
      }
    }
  }

  private removeIfCurrent(recoveryId: string, expiresAt: number): void {
    const entry = this.snapshots.get(recoveryId);
    if (entry?.snapshot.expiresAt === expiresAt) {
      this.remove(recoveryId);
    }
  }
}

function summarizePiAuthRecoverySnapshot(
  snapshot: PiAuthRecoverySnapshot,
): PiAuthRecoverySnapshotSummary {
  return {
    recoveryId: snapshot.recoveryId,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    sendCount: snapshot.failedDispatch.sendCount,
    sourceKey: snapshot.failedDispatch.sourceKey,
    eventTypes: [...snapshot.failedDispatch.eventTypes],
    eventCount: snapshot.failedDispatch.eventCount,
    contentBytes: snapshot.contentBytes,
    automaticRetryAttempts: snapshot.failure.automaticRetryAttempts,
    toolCallStarted: snapshot.failure.toolCallStarted,
  };
}

function cloneSnapshot(snapshot: PiAuthRecoverySnapshot): PiAuthRecoverySnapshot {
  return {
    ...snapshot,
    failedDispatch: cloneFailedDispatch(snapshot.failedDispatch),
    failure: { ...snapshot.failure },
  };
}

function cloneFailedDispatch(
  failedDispatch: ConductorRecoveryReportEvent['failedDispatch'],
): ConductorRecoveryReportEvent['failedDispatch'] {
  return {
    ...failedDispatch,
    eventTypes: [...failedDispatch.eventTypes],
    eventReferences: failedDispatch.eventReferences.map((reference) => ({
      ...reference,
    })),
  };
}
