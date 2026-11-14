import type { ConductorSendResult } from './conductor-agent.js';
import { isConductorSendAuthError } from './conductor-auth.js';
import { isConductorSendTransportError } from './conductor-send-reconnect.js';

export const CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT = 4;
export const CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS = 30 * 60 * 1_000;
export const CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT = 1_048_576;
export const CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT =
  CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT * CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT;

export type ConductorRecoveryWorkflow = 'issue' | 'operator-agent';
export type ConductorRecoveryBackend = 'cursor' | 'pi';
export type ConductorRecoveryFailureClass =
  | 'auth'
  | 'transport'
  | 'provider_error'
  | 'cancelled'
  | 'send_rejected'
  | 'incomplete_status';

/** Classifies a final send outcome without retaining its raw error text. */
export function classifyConductorRecoveryFailure(
  result: ConductorSendResult,
): ConductorRecoveryFailureClass {
  if (result.status === 'send_rejected') return 'send_rejected';
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status !== 'error') return 'incomplete_status';
  if (isConductorSendAuthError(result)) return 'auth';
  if (isConductorSendTransportError(result)) return 'transport';
  return 'provider_error';
}

export interface ConductorRecoveryReconnect {
  reason: 'auth' | 'transport';
  succeeded: boolean;
}

/** Metadata recorded beside operator-authored input; raw errors are excluded. */
export interface ConductorRecoveryAttemptMetadata {
  recoveryId: string;
  workflow: ConductorRecoveryWorkflow;
  backend: ConductorRecoveryBackend;
  sendCount: number;
  runId?: string;
  sourceKey: string;
  eventTypes: string[];
  status: string;
  failureClass: ConductorRecoveryFailureClass;
  automaticReconnect?: ConductorRecoveryReconnect;
  automaticRetryAttempts: 0;
  toolCallStarted: boolean;
}

export interface ConductorRecoverySnapshot
  extends ConductorRecoveryAttemptMetadata {
  createdAt: number;
  expiresAt: number;
  inputTexts: string[];
  inputCount: number;
  contentBytes: number;
}

export interface ConductorRecoverySnapshotSummary
  extends ConductorRecoveryAttemptMetadata {
  createdAt: number;
  expiresAt: number;
  inputCount: number;
  contentBytes: number;
}

export interface ConductorRecoveryReservation {
  readonly token: symbol;
  readonly contentBytes: number;
}

export type ConductorRecoveryReservationResult =
  | { ok: true; reservation?: ConductorRecoveryReservation }
  | { ok: false; reason: 'input_too_large' | 'capacity' };

interface StoredSnapshot {
  snapshot: ConductorRecoverySnapshot;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface StoredReservation {
  token: symbol;
  contentBytes: number;
}

/** Process-local, operator-only store for failed user-authored input. */
export class ConductorRecoveryInbox {
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly reservations = new Map<symbol, StoredReservation>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  reserve(inputTexts: readonly string[]): ConductorRecoveryReservationResult {
    if (this.disposed) {
      return { ok: false, reason: 'capacity' };
    }

    this.pruneExpired(Date.now());
    if (inputTexts.length === 0) {
      return { ok: true };
    }

    const contentBytes = inputTexts.reduce(
      (total, text) => total + Buffer.byteLength(text, 'utf8'),
      0,
    );
    if (contentBytes > CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT) {
      return { ok: false, reason: 'input_too_large' };
    }
    if (
      this.snapshots.size + this.reservations.size >=
        CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT ||
      this.totalBytes() + contentBytes > CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT
    ) {
      return { ok: false, reason: 'capacity' };
    }

    const token = Symbol('conductor-recovery-reservation');
    this.reservations.set(token, { token, contentBytes });
    this.notify();
    return { ok: true, reservation: { token, contentBytes } };
  }

  release(reservation: ConductorRecoveryReservation): boolean {
    const stored = this.reservations.get(reservation.token);
    if (!stored) return false;
    this.reservations.delete(reservation.token);
    this.notify();
    return true;
  }

  commit(
    reservation: ConductorRecoveryReservation,
    metadata: ConductorRecoveryAttemptMetadata,
    inputTexts: readonly string[],
    now = Date.now(),
  ): ConductorRecoverySnapshotSummary | undefined {
    const stored = this.reservations.get(reservation.token);
    if (
      this.disposed ||
      !stored ||
      stored.contentBytes !== reservation.contentBytes ||
      sumUtf8Bytes(inputTexts) !== stored.contentBytes
    ) {
      return undefined;
    }

    this.pruneExpired(now);
    if (this.snapshots.has(metadata.recoveryId)) {
      throw new Error(
        `Conductor recovery snapshot already exists: ${metadata.recoveryId}`,
      );
    }

    const snapshot: ConductorRecoverySnapshot = {
      ...cloneMetadata(metadata),
      createdAt: now,
      expiresAt: now + CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS,
      inputTexts: [...inputTexts],
      inputCount: inputTexts.length,
      contentBytes: stored.contentBytes,
    };
    const expiryTimer = setTimeout(() => {
      this.removeIfCurrent(snapshot.recoveryId, snapshot.expiresAt);
    }, CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS);
    expiryTimer.unref?.();
    this.reservations.delete(reservation.token);
    this.snapshots.set(snapshot.recoveryId, { snapshot, expiryTimer });
    this.notify();
    return summarizeSnapshot(snapshot);
  }

  list(now = Date.now()): ConductorRecoverySnapshotSummary[] {
    this.pruneExpired(now);
    return [...this.snapshots.values()].map(({ snapshot }) =>
      summarizeSnapshot(snapshot),
    );
  }

  get(
    recoveryId: string,
    now = Date.now(),
  ): ConductorRecoverySnapshot | undefined {
    this.pruneExpired(now);
    const snapshot = this.snapshots.get(recoveryId)?.snapshot;
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  remove(recoveryId: string): boolean {
    const entry = this.snapshots.get(recoveryId);
    if (!entry) return false;
    clearTimeout(entry.expiryTimer);
    this.snapshots.delete(recoveryId);
    this.notify();
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.snapshots.values()) {
      clearTimeout(entry.expiryTimer);
    }
    this.snapshots.clear();
    this.reservations.clear();
    this.notify();
    this.listeners.clear();
  }

  private totalBytes(): number {
    let total = 0;
    for (const { snapshot } of this.snapshots.values()) {
      total += snapshot.contentBytes;
    }
    for (const reservation of this.reservations.values()) {
      total += reservation.contentBytes;
    }
    return total;
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

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function sumUtf8Bytes(inputTexts: readonly string[]): number {
  return inputTexts.reduce(
    (total, text) => total + Buffer.byteLength(text, 'utf8'),
    0,
  );
}

function cloneMetadata(
  metadata: ConductorRecoveryAttemptMetadata,
): ConductorRecoveryAttemptMetadata {
  return {
    ...metadata,
    eventTypes: [...metadata.eventTypes],
    ...(metadata.automaticReconnect
      ? { automaticReconnect: { ...metadata.automaticReconnect } }
      : {}),
  };
}

function summarizeSnapshot(
  snapshot: ConductorRecoverySnapshot,
): ConductorRecoverySnapshotSummary {
  const {
    inputTexts: _inputTexts,
    ...summary
  } = snapshot;
  return {
    ...summary,
    eventTypes: [...summary.eventTypes],
    ...(summary.automaticReconnect
      ? { automaticReconnect: { ...summary.automaticReconnect } }
      : {}),
  };
}

function cloneSnapshot(
  snapshot: ConductorRecoverySnapshot,
): ConductorRecoverySnapshot {
  return {
    ...snapshot,
    eventTypes: [...snapshot.eventTypes],
    inputTexts: [...snapshot.inputTexts],
    ...(snapshot.automaticReconnect
      ? { automaticReconnect: { ...snapshot.automaticReconnect } }
      : {}),
  };
}
