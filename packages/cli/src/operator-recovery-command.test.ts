import { describe, expect, it, vi } from 'vitest';
import type {
  ConductorRecoverySnapshot,
  ConductorRecoverySnapshotSummary,
  RecoveryInboxCommandApi,
} from '@agents-ensemble/core';
import { executeRecoveryInboxCommand } from './operator-recovery-command.js';

const summary: ConductorRecoverySnapshotSummary = {
  recoveryId: 'conductor-recovery-12',
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_001_800_000,
  sendCount: 12,
  workflow: 'issue',
  backend: 'pi',
  sourceKey: 'worker:implementer',
  eventTypes: ['worker.completed', 'operator.message'],
  status: 'error',
  failureClass: 'auth',
  automaticReconnect: { reason: 'auth', succeeded: true },
  automaticRetryAttempts: 0,
  toolCallStarted: true,
  inputCount: 1,
  contentBytes: 42,
};

const snapshot: ConductorRecoverySnapshot = {
  ...summary,
  runId: 'pi-run-12',
  inputTexts: ['private task \u001b[31mred\u001b[0m\u202e\u061c'],
};

function createApi(): RecoveryInboxCommandApi {
  return {
    listRecoverySnapshots: vi.fn(() => [summary]),
    getRecoverySnapshot: vi.fn((recoveryId) =>
      recoveryId === snapshot.recoveryId ? snapshot : undefined,
    ),
    clearRecoverySnapshot: vi.fn((recoveryId) =>
      recoveryId === snapshot.recoveryId,
    ),
    continueAfterRecovery: vi.fn(() => true),
    recoveryAttentionAttemptId: vi.fn(() => '12'),
  };
}

describe('executeRecoveryInboxCommand', () => {
  it('treats `/recovery` as a local list command without revealing payloads', () => {
    const api = createApi();
    const result = executeRecoveryInboxCommand(api, '  /recovery  ');

    expect(result.handled).toBe(true);
    expect(result.inspection?.text).toContain(snapshot.recoveryId);
    expect(result.inspection?.text).toContain('本文は表示せず');
    expect(result.inspection?.text).not.toContain('private task');
    expect(api.listRecoverySnapshots).toHaveBeenCalledOnce();
    expect(api.getRecoverySnapshot).not.toHaveBeenCalled();
  });

  it('escapes untrusted source metadata before listing it on a terminal', () => {
    const api = createApi();
    api.listRecoverySnapshots = vi.fn(() => [
      {
        ...summary,
        sourceKey: 'worker:name\u001b[2J\u202e',
      },
    ]);

    const result = executeRecoveryInboxCommand(api, '/recovery list');
    const text = result.inspection?.text ?? '';

    expect(text).toContain('worker:name\\u001b[2J\\u202e');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u202e');
  });

  it('does not retrieve sensitive content when output is not an interactive TTY', () => {
    const api = createApi();
    const result = executeRecoveryInboxCommand(
      api,
      `/recovery show ${snapshot.recoveryId}`,
    );

    expect(result.handled).toBe(true);
    expect(result.inspection?.text).toContain('対話 TTY 上でのみ表示');
    expect(result.inspection?.text).not.toContain('private task');
    expect(api.getRecoverySnapshot).not.toHaveBeenCalled();
  });

  it('shows full content only on explicit TTY inspection and escapes terminal controls', () => {
    const api = createApi();
    const result = executeRecoveryInboxCommand(
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
    expect(text).toContain('conductor への送信や失敗 input の再実行は起きません');
    expect(text).toContain('false でも副作用がなかった証拠にはなりません');
    expect(text).toContain('元の入力をそのまま再入力すると');
    expect(api.getRecoverySnapshot).toHaveBeenCalledWith(snapshot.recoveryId);
  });

  it('deletes only the requested snapshot and handles hide without sending', () => {
    const api = createApi();
    const cleared = executeRecoveryInboxCommand(
      api,
      `/recovery clear ${snapshot.recoveryId}`,
    );
    expect(api.clearRecoverySnapshot).toHaveBeenCalledWith(
      snapshot.recoveryId,
    );
    expect(cleared.inspection?.text).toContain('recovery inbox から削除');
    expect(cleared.inspection?.text).toContain('完全消去は保証しません');

    const continued = executeRecoveryInboxCommand(api, '/recovery continue');
    expect(continued.inspection?.text).toContain('確認を受け付けました');
    expect(api.continueAfterRecovery).toHaveBeenCalledOnce();

    const hidden = executeRecoveryInboxCommand(
      api,
      '/recovery hide',
      { canDisplaySensitiveContent: true },
    );
    expect(hidden).toEqual({ handled: true });
  });

  it('leaves ordinary operator messages on the normal submit path', () => {
    const result = executeRecoveryInboxCommand(createApi(), 'please continue');
    expect(result).toEqual({ handled: false });
  });
});
