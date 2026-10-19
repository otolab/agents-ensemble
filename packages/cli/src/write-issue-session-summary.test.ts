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
    expect(text).toContain('全体: input 120 / output 30');
    expect(text).toContain('conductor: input 80 / output 20');
    expect(text).toContain('worker implementer: input 40 / output 10');
    expect(text).toContain('コンテキスト圧縮: 1 回');
    expect(text).not.toContain('課金');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
