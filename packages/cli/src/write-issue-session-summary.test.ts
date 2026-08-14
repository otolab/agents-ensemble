import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConductorSessionResult } from '@agents-ensemble/core';
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
});
