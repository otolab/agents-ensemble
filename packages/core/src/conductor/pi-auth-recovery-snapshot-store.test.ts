import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PiAuthRecoverySnapshotStore,
  PI_AUTH_RECOVERY_SNAPSHOT_LIMIT,
  PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS,
} from './pi-auth-recovery-snapshot-store.js';
import type { PiAuthRecoverySnapshotCandidate } from './pi-auth-recovery-snapshot-store.js';

const createdStores: PiAuthRecoverySnapshotStore[] = [];

function createStore(): PiAuthRecoverySnapshotStore {
  const store = new PiAuthRecoverySnapshotStore();
  createdStores.push(store);
  return store;
}

function createCandidate(index: number): PiAuthRecoverySnapshotCandidate {
  return {
    recoveryId: `pi-auth-recovery-${index}`,
    failedDispatch: {
      sendCount: index,
      runId: `run-${index}`,
      sourceKey: 'operator',
      eventTypes: ['operator.message'],
      eventCount: 1,
      eventReferences: [
        {
          eventIndex: 1,
          type: 'operator.message',
          reference: 'delivery:next',
        },
      ],
      eventReferencesTruncated: false,
    },
    failure: {
      kind: 'pi_api_key_resolution',
      automaticRetryAttempts: 1,
      toolCallStarted: false,
    },
  };
}

describe('PiAuthRecoverySnapshotStore', () => {
  afterEach(() => {
    for (const store of createdStores.splice(0)) {
      store.dispose();
    }
    vi.useRealTimers();
  });

  it('keeps the full rendered dispatch only in the snapshot and returns copies', () => {
    const store = createStore();
    const candidate = createCandidate(1);
    const content = 'private operator instruction\nworker result';

    const added = store.add(candidate, content);
    expect(added?.snapshot.recoveryId).toBe(candidate.recoveryId);
    expect(added?.snapshot.contentBytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(added?.snapshot).not.toHaveProperty('content');

    candidate.failedDispatch.eventTypes.push('worker.completed');
    const snapshot = store.get(candidate.recoveryId);
    expect(snapshot?.content).toBe(content);
    expect(snapshot?.failedDispatch.eventTypes).toEqual(['operator.message']);

    snapshot?.failedDispatch.eventTypes.push('mutated by caller');
    expect(store.get(candidate.recoveryId)?.failedDispatch.eventTypes).toEqual([
      'operator.message',
    ]);
  });

  it('evicts the oldest dispatch when the four snapshot limit is reached', () => {
    const store = createStore();

    for (let index = 1; index <= PI_AUTH_RECOVERY_SNAPSHOT_LIMIT; index += 1) {
      expect(store.add(createCandidate(index), `content-${index}`)?.evictedRecoveryIds)
        .toEqual([]);
    }

    const fifth = store.add(createCandidate(5), 'content-5');
    expect(fifth?.evictedRecoveryIds).toEqual(['pi-auth-recovery-1']);
    expect(store.list().map((snapshot) => snapshot.recoveryId)).toEqual([
      'pi-auth-recovery-2',
      'pi-auth-recovery-3',
      'pi-auth-recovery-4',
      'pi-auth-recovery-5',
    ]);
  });

  it('expires snapshots at the configured lifetime and rejects later lookup', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = createStore();

    const added = store.add(createCandidate(1), 'private content');
    expect(added?.snapshot.expiresAt).toBe(
      now.getTime() + PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS,
    );

    vi.advanceTimersByTime(PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS - 1);
    expect(store.get('pi-auth-recovery-1')).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(store.get('pi-auth-recovery-1')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('expires by elapsed lifetime even if the wall clock moves backward', () => {
    const now = new Date('2026-11-10T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = createStore();

    store.add(createCandidate(1), 'private content');
    vi.setSystemTime(now.getTime() - PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS);

    vi.advanceTimersByTime(PI_AUTH_RECOVERY_SNAPSHOT_TTL_MS);
    expect(store.get('pi-auth-recovery-1')).toBeUndefined();
  });

  it('clears retained payloads on dispose and refuses new snapshots', () => {
    const store = createStore();
    store.add(createCandidate(1), 'private content');

    store.dispose();
    expect(store.list()).toEqual([]);
    expect(store.get('pi-auth-recovery-1')).toBeUndefined();
    expect(store.add(createCandidate(2), 'later content')).toBeUndefined();
  });
});
