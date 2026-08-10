import { describe, expect, it, vi } from 'vitest';
import { createDialogueSink, createHarnessSink } from './session-sinks.js';

describe('session sinks', () => {
  it('formats harness events on stderr', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    createHarnessSink()({
      type: 'conductor.send',
      sendCount: 2,
      runId: 'run-2',
      status: 'error',
      error: { message: 'Model Blocked' },
      workerDispatches: 0,
      workerFailures: 0,
    });

    expect(stderr).toHaveBeenCalledWith(
      '[harness] conductor.send n=2 status=error workerDone=0 workerFailed=0',
    );
    expect(stderr).toHaveBeenCalledWith('[harness] conductor.error Model Blocked');

    stderr.mockRestore();
  });

  it('formats dialogue for operator and conductor', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const sink = createDialogueSink();
    sink({ type: 'operator.input', conductorTurn: 1, text: 'hello' });
    sink({
      type: 'conductor.send',
      sendCount: 1,
      runId: 'run-1',
      status: 'finished',
      result: 'conductor-ok',
      workerDispatches: 0,
      workerFailures: 0,
    });
    sink({
      type: 'worker.round',
      dispatch: {
        name: 'w',
        kind: 'w',
        issue: {
          owner: 'o',
          repo: 'r',
          number: 1,
          url: 'https://github.com/o/r/issues/1',
        },
        worktree: {
          path: '/wt',
          branch: 'b',
          issue: {
            owner: 'o',
            repo: 'r',
            number: 1,
            url: 'https://github.com/o/r/issues/1',
          },
        },
        prompt: 'p',
        promptResult: { stopReason: 'end_turn', responseText: 'hidden' },
        acpSessionId: 's',
      },
    });

    expect(write).toHaveBeenCalledWith('\noperator> hello\n');
    expect(write).toHaveBeenCalledWith('\nconductor> conductor-ok\n');
    expect(write).toHaveBeenCalledTimes(2);

    write.mockRestore();
  });
});
