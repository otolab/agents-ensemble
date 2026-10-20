import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SessionUsageTracker,
  type ConductorSessionResult,
} from '@agents-ensemble/core';
import { writeIssueSessionSummary } from './write-issue-session-summary.js';

const BASE_SUMMARY = {
  agentId: 'agent-1',
  issueUrl: 'https://github.com/org/repo/issues/1',
  repoRoot: '/repo',
  startedAt: 1_750_000_000_000,
  durationMs: 1_250,
  sendCount: 1,
  stopReason: 'completed',
  lastRunStatus: 'finished',
  workerDispatches: [],
  workerFailures: [],
  escalations: [],
  openQuestions: [],
} satisfies ConductorSessionResult;

describe('writeIssueSessionSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes JSON to stdout', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(BASE_SUMMARY, { format: 'json' });

    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      agentId: 'agent-1',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('writes text summary to stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(BASE_SUMMARY, { format: 'text' });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('セッション終了');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('writes tracker metrics from a ConductorSessionResult through the text formatter', () => {
    const tracker = new SessionUsageTracker({ trackCompactions: true });
    tracker.recordConductorRound({
      runId: 'run-1',
      status: 'finished',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    tracker.recordWorkerRound({
      name: 'implementer',
      kind: 'implementer',
      prompt: 'implement the issue',
      promptResult: {
        stopReason: 'end_turn',
        responseText: 'implemented',
        usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      },
    });
    tracker.recordContextCompaction();
    const result = {
      ...BASE_SUMMARY,
      sessionUsage: tracker.getSessionSummary(),
    } satisfies ConductorSessionResult;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(result, { format: 'text' });

    const text = String(errorSpy.mock.calls[0]?.[0]);
    expect(text).toContain('取得・記録済み合計: input 120 / output 30');
    expect(text).toContain('conductor: input 80 / output 20');
    expect(text).toContain('worker implementer: input 40 / output 10');
    expect(text).toContain('コンテキスト圧縮: 1 回');
    expect(text).not.toContain('課金');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('keeps conductor cost scoped when a failed worker has no usage round', () => {
    const tracker = new SessionUsageTracker();
    tracker.recordConductorRound({
      runId: 'run-worker-failure',
      status: 'finished',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    const result = {
      ...BASE_SUMMARY,
      workerFailures: [
        {
          workerId: 'worker-implementer',
          name: 'implementer',
          kind: 'implementer',
          issueUrl: BASE_SUMMARY.issueUrl,
          error: 'ACP disconnected after the prompt started',
        },
      ],
      sessionUsage: {
        ...tracker.getSessionSummary(),
        cost: {
          rawCostCents: 51,
          chargedCents: 42,
          scope: 'conductor-only' as const,
        },
      },
    } satisfies ConductorSessionResult;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    writeIssueSessionSummary(result, { format: 'text' });

    const text = String(errorSpy.mock.calls[0]?.[0]);
    expect(text).toContain('worker ラウンド: 0 完了 / 1 失敗');
    expect(text).toContain('取得・記録済み合計: input 80 / output 20');
    expect(text).toContain(
      '失敗などで usage が未記録の消費分は含まれません。',
    );
    expect(text).not.toContain('全体: input 80 / output 20');
    expect(text).toContain(
      '課金（取得できた conductor 実課金。worker 分は未算出）: $0.42 (raw $0.51)',
    );
    expect(text).not.toContain('全体 = conductor');
    expect(text).not.toContain('全体: $0.42');
  });
});
