import { describe, expect, it } from 'vitest';
import {
  formatConductorActivityBody,
  formatHarnessLogBody,
  formatObservationLogBody,
} from './session-log-lines.js';

describe('session-log-lines', () => {
  it('formats harness bodies', () => {
    expect(
      formatHarnessLogBody({
        type: 'conductor.send',
        sendCount: 1,
        runId: 'run-1',
        status: 'finished',
        result: 'ok',
        workerDispatches: 0,
        workerFailures: 0,
      }),
    ).toBe('conductor.send n=1 status=finished workerDone=0 workerFailed=0');
  });

  it('formats observation bodies', () => {
    expect(
      formatObservationLogBody({
        type: 'session.post_loop_wait',
      }),
    ).toContain('自律作業が一段落しました');
  });

  it('formats conductor activity bodies', () => {
    expect(
      formatConductorActivityBody({
        type: 'conductor.send',
        sendCount: 1,
        runId: 'run-1',
        status: 'finished',
        result: 'hello conductor',
        workerDispatches: 0,
        workerFailures: 0,
      }),
    ).toBe('hello conductor');
  });
});
