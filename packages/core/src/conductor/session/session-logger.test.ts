import { describe, expect, it, vi } from 'vitest';
import { SessionLogger } from './session-logger.js';

const TEST_DISPATCH = {
  name: 'ping-1',
  kind: 'ping',
  issue: {
    owner: 'org',
    repo: 'repo',
    number: 1,
    url: 'https://github.com/org/repo/issues/1',
  },
  worktree: {
    path: '/tmp/wt',
    branch: 'ensemble/issue-1',
    issue: {
      owner: 'org',
      repo: 'repo',
      number: 1,
      url: 'https://github.com/org/repo/issues/1',
    },
  },
  prompt: 'wait',
  promptResult: { stopReason: 'end_turn', responseText: 'pong' },
  acpSessionId: 'sess-1',
};

describe('SessionLogger', () => {
  it('records events and builds a ConductorSessionResult-compatible snapshot', () => {
    const logger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const events: string[] = [];
    logger.subscribe((event) => {
      events.push(event.type);
    });

    logger.emit({
      type: 'harness.worktree',
      path: '/tmp/wt',
      branch: 'ensemble/issue-1',
      mode: 'isolated',
    });
    logger.emit({ type: 'worker.round', dispatch: TEST_DISPATCH });
    logger.emit({
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'conductor-ok',
      workerDispatches: 1,
      workerFailures: 0,
    });
    logger.finish('completed');

    const summary = logger.snapshot({
      agentId: 'agent-1',
      escalations: [],
      openQuestions: [],
    });

    expect(events).toEqual([
      'harness.worktree',
      'worker.round',
      'conductor.send',
      'session.stop',
    ]);
    expect(summary.sendCount).toBe(1);
    expect(summary.lastResult).toBe('conductor-ok');
    expect(summary.workerDispatches).toHaveLength(1);
    expect(summary.stopReason).toBe('completed');
  });

  it('overwrites last conductor send in snapshot', () => {
    const logger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });

    logger.emit({
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'first',
      workerDispatches: 0,
      workerFailures: 0,
    });
    logger.emit({
      type: 'conductor.send',
      sendCount: 2,
      runId: 'run-2',
      status: 'error',
      error: { message: 'Model Blocked' },
      workerDispatches: 0,
      workerFailures: 0,
    });
    logger.finish('error');

    const summary = logger.snapshot({
      agentId: 'agent-1',
      escalations: [],
      openQuestions: [],
    });

    expect(summary.sendCount).toBe(2);
    expect(summary.lastResult).toBeUndefined();
    expect(summary.lastError?.message).toBe('Model Blocked');
    expect(summary.stopReason).toBe('error');
  });

  it('unsubscribes sinks', () => {
    const logger = new SessionLogger({
      issueUrl: 'https://github.com/org/repo/issues/1',
      repoRoot: '/repo',
    });
    const sink = vi.fn();
    const unsubscribe = logger.subscribe(sink);

    logger.emit({ type: 'operator.input', conductorTurn: 1, text: 'hi' });
    unsubscribe();
    logger.emit({ type: 'operator.input', conductorTurn: 2, text: 'bye' });

    expect(sink).toHaveBeenCalledTimes(1);
  });
});
