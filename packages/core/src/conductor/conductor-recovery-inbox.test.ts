import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
  CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT,
  CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS,
  CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT,
  ConductorRecoveryInbox,
} from './conductor-recovery-inbox.js';
import type { ConductorRecoveryAttemptMetadata } from './conductor-recovery-inbox.js';

const createdInboxes: ConductorRecoveryInbox[] = [];

function createInbox(): ConductorRecoveryInbox {
  const inbox = new ConductorRecoveryInbox();
  createdInboxes.push(inbox);
  return inbox;
}

function metadata(index: number): ConductorRecoveryAttemptMetadata {
  return {
    recoveryId: `conductor-recovery-${index}`,
    workflow: 'issue',
    backend: 'pi',
    sendCount: index,
    runId: `run-${index}`,
    sourceKey: 'operator',
    eventTypes: ['operator.message'],
    status: 'error',
    failureClass: 'auth',
    automaticReconnect: { reason: 'auth', succeeded: true },
    automaticRetryAttempts: 0,
    toolCallStarted: false,
  };
}

describe('ConductorRecoveryInbox', () => {
  afterEach(() => {
    for (const inbox of createdInboxes.splice(0)) inbox.dispose();
    vi.useRealTimers();
  });

  it('reserves before send and commits operator-authored input without copying it into metadata', () => {
    const inbox = createInbox();
    const inputTexts = ['first line', 'second line'];
    const reservationResult = inbox.reserve(inputTexts);
    expect(reservationResult.ok).toBe(true);
    if (!reservationResult.ok || !reservationResult.reservation) {
      throw new Error('Expected an inbox reservation.');
    }

    expect(inbox.list()).toEqual([]);
    const summary = inbox.commit(
      reservationResult.reservation,
      metadata(1),
      inputTexts,
    );

    expect(summary).toMatchObject({
      recoveryId: 'conductor-recovery-1',
      inputCount: 2,
      contentBytes: Buffer.byteLength('first line') + Buffer.byteLength('second line'),
      automaticRetryAttempts: 0,
    });
    expect(summary).not.toHaveProperty('inputTexts');
    expect(inbox.get('conductor-recovery-1')?.inputTexts).toEqual(inputTexts);
  });

  it('enforces the per-dispatch byte ceiling before an attempt starts', () => {
    const inbox = createInbox();
    const tooLarge = 'a'.repeat(CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT + 1);

    expect(inbox.reserve([tooLarge])).toEqual({
      ok: false,
      reason: 'input_too_large',
    });
    expect(inbox.list()).toEqual([]);
  });

  it('keeps complete snapshots and refuses new admission when count capacity is full', () => {
    const inbox = createInbox();

    for (let index = 1; index <= CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT; index += 1) {
      const inputTexts = [`complete input ${index}`];
      const reserved = inbox.reserve(inputTexts);
      expect(reserved.ok).toBe(true);
      if (reserved.ok && reserved.reservation) {
        inbox.commit(reserved.reservation, metadata(index), inputTexts);
      }
    }

    expect(inbox.reserve(['next input'])).toEqual({
      ok: false,
      reason: 'capacity',
    });
    expect(inbox.list().map((item) => item.recoveryId)).toEqual([
      'conductor-recovery-1',
      'conductor-recovery-2',
      'conductor-recovery-3',
      'conductor-recovery-4',
    ]);
  });

  it('accounts for reserved bytes before committing concurrent arrivals', () => {
    const inbox = createInbox();
    const reservations = [];
    for (let index = 0; index < CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT; index += 1) {
      const reserved = inbox.reserve([
        String(index).repeat(CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT),
      ]);
      expect(reserved.ok).toBe(true);
      if (reserved.ok && reserved.reservation) {
        reservations.push(reserved.reservation);
      }
    }

    expect(inbox.reserve(['another input'])).toEqual({
      ok: false,
      reason: 'capacity',
    });
    expect(inbox.reserve([])).toEqual({ ok: true });
    expect(inbox.list()).toEqual([]);
    expect(CONDUCTOR_RECOVERY_TOTAL_BYTE_LIMIT).toBe(
      CONDUCTOR_RECOVERY_SNAPSHOT_LIMIT * CONDUCTOR_RECOVERY_INPUT_BYTE_LIMIT,
    );
    for (const reservation of reservations) inbox.release(reservation);
  });

  it('expires a snapshot after the configured TTL', () => {
    const now = new Date('2026-11-12T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const inbox = createInbox();
    const inputTexts = ['private input'];
    const reserved = inbox.reserve(inputTexts);
    if (!reserved.ok || !reserved.reservation) {
      throw new Error('Expected an inbox reservation.');
    }
    inbox.commit(reserved.reservation, metadata(1), inputTexts);

    vi.advanceTimersByTime(CONDUCTOR_RECOVERY_SNAPSHOT_TTL_MS - 1);
    expect(inbox.get('conductor-recovery-1')).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(inbox.get('conductor-recovery-1')).toBeUndefined();
    expect(inbox.list()).toEqual([]);
  });

  it('releases capacity when cleared or disposed', () => {
    const inbox = createInbox();
    const inputTexts = ['private input'];
    const reserved = inbox.reserve(inputTexts);
    if (!reserved.ok || !reserved.reservation) {
      throw new Error('Expected an inbox reservation.');
    }
    inbox.commit(reserved.reservation, metadata(1), inputTexts);

    expect(inbox.remove('conductor-recovery-1')).toBe(true);
    expect(inbox.reserve(['next input']).ok).toBe(true);

    inbox.dispose();
    expect(inbox.reserve(['later input'])).toEqual({
      ok: false,
      reason: 'capacity',
    });
  });

  it('notifies subscribers after capacity is cleared', () => {
    const inbox = createInbox();
    const inputTexts = ['private input'];
    const reserved = inbox.reserve(inputTexts);
    if (!reserved.ok || !reserved.reservation) {
      throw new Error('Expected an inbox reservation.');
    }
    inbox.commit(reserved.reservation, metadata(1), inputTexts);
    const listener = vi.fn();
    inbox.subscribe(listener);

    inbox.remove('conductor-recovery-1');
    expect(listener).toHaveBeenCalledOnce();
  });
});
