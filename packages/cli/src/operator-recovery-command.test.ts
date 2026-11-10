import { describe, expect, it, vi } from 'vitest';
import type {
  OperatorInputBindingApi,
  PiAuthRecoverySnapshot,
  PiAuthRecoverySnapshotSummary,
} from '@agents-ensemble/core';
import { executePiAuthRecoveryCommand } from './operator-recovery-command.js';

const summary: PiAuthRecoverySnapshotSummary = {
  recoveryId: 'pi-auth-recovery-12',
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_001_800_000,
  sendCount: 12,
  sourceKey: 'worker:implementer',
  eventTypes: ['worker.completed', 'operator.message'],
  eventCount: 2,
  contentBytes: 42,
  automaticRetryAttempts: 1,
  toolCallStarted: true,
};

const snapshot: PiAuthRecoverySnapshot = {
  ...summary,
  failedDispatch: {
    sendCount: summary.sendCount,
    runId: 'pi-run-12',
    sourceKey: summary.sourceKey,
    eventTypes: summary.eventTypes,
    eventCount: summary.eventCount,
    eventReferences: [],
    eventReferencesTruncated: false,
  },
  failure: {
    kind: 'pi_api_key_resolution',
    automaticRetryAttempts: 1,
    toolCallStarted: true,
  },
  content: 'private task \u001b[31mred\u001b[0m\u202e\u061c',
  contentBytes: 42,
};

function createApi(): OperatorInputBindingApi {
  return {
    submit: vi.fn(() => true),
    getContext: () => ({
      conductorTurn: 1,
      autonomousTurns: 0,
      maxTurns: null,
      openQuestions: [],
    }),
    listPiAuthRecoverySnapshots: vi.fn(() => [summary]),
    getPiAuthRecoverySnapshot: vi.fn((recoveryId) =>
      recoveryId === snapshot.recoveryId ? snapshot : undefined,
    ),
    clearPiAuthRecoverySnapshot: vi.fn((recoveryId) =>
      recoveryId === snapshot.recoveryId,
    ),
  };
}

describe('executePiAuthRecoveryCommand', () => {
  it('treats `/recovery` as a local list command without revealing payloads', () => {
    const api = createApi();
    const result = executePiAuthRecoveryCommand(api, '  /recovery  ');

    expect(result.handled).toBe(true);
    expect(result.inspection?.text).toContain(snapshot.recoveryId);
    expect(result.inspection?.text).toContain('本文はここには表示しません');
    expect(result.inspection?.text).not.toContain('private task');
    expect(api.listPiAuthRecoverySnapshots).toHaveBeenCalledOnce();
    expect(api.getPiAuthRecoverySnapshot).not.toHaveBeenCalled();
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('escapes untrusted source metadata before listing it on a terminal', () => {
    const api = createApi();
    api.listPiAuthRecoverySnapshots = vi.fn(() => [
      {
        ...summary,
        sourceKey: 'worker:name\u001b[2J\u202e',
      },
    ]);

    const result = executePiAuthRecoveryCommand(api, '/recovery list');
    const text = result.inspection?.text ?? '';

    expect(text).toContain('worker:name\\u001b[2J\\u202e');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u202e');
  });

  it('does not retrieve sensitive content when output is not an interactive TTY', () => {
    const api = createApi();
    const result = executePiAuthRecoveryCommand(
      api,
      `/recovery show ${snapshot.recoveryId}`,
    );

    expect(result.handled).toBe(true);
    expect(result.inspection?.text).toContain('対話 TTY 上でのみ表示');
    expect(result.inspection?.text).not.toContain('private task');
    expect(api.getPiAuthRecoverySnapshot).not.toHaveBeenCalled();
  });

  it('shows full content only on explicit TTY inspection and escapes terminal controls', () => {
    const api = createApi();
    const result = executePiAuthRecoveryCommand(
      api,
      `/recovery show ${snapshot.recoveryId}`,
      { canDisplaySensitiveContent: true },
    );
    const text = result.inspection?.text ?? '';

    expect(result.handled).toBe(true);
    expect(result.inspection).toMatchObject({
      recoveryId: snapshot.recoveryId,
      expiresAt: snapshot.expiresAt,
      sensitive: true,
    });
    expect(text).toContain('private task \\u001b[31mred\\u001b[0m\\u202e\\u061c');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u202e');
    expect(text).not.toContain('\u061c');
    expect(text).toContain('再実行しません');
    expect(text).toContain('false でも副作用がなかった証拠にはなりません');
    expect(text).toContain('本文全体をそのまま再入力すると');
    expect(api.getPiAuthRecoverySnapshot).toHaveBeenCalledWith(snapshot.recoveryId);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('deletes only the requested snapshot and handles hide without sending', () => {
    const api = createApi();
    const cleared = executePiAuthRecoveryCommand(
      api,
      `/recovery clear ${snapshot.recoveryId}`,
    );
    expect(api.clearPiAuthRecoverySnapshot).toHaveBeenCalledWith(
      snapshot.recoveryId,
    );
    expect(cleared.inspection?.text).toContain('recovery inbox から削除');
    expect(cleared.inspection?.text).toContain('完全消去は保証しません');

    const hidden = executePiAuthRecoveryCommand(
      api,
      '/recovery hide',
      { canDisplaySensitiveContent: true },
    );
    expect(hidden).toEqual({ handled: true });
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('leaves ordinary operator messages on the normal submit path', () => {
    const result = executePiAuthRecoveryCommand(createApi(), 'please continue');
    expect(result).toEqual({ handled: false });
  });
});
