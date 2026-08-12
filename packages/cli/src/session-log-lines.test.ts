import { describe, expect, it } from 'vitest';
import {
  formatConductorActivityBody,
  formatHarnessLogBody,
  formatObservationLogBody,
  formatObservationStderrLine,
} from './session-log-lines.js';

describe('session-log-lines', () => {
  it('formats permission.pending harness body', () => {
    expect(
      formatHarnessLogBody({
        type: 'permission.pending',
        workerLabel: 'implementer',
        permission: {
          id: 'perm-3',
          workerId: 'worker-uuid',
          createdAt: 0,
          request: {
            toolName: 'Shell',
            raw: { toolName: 'Shell', input: { command: 'npm test' } },
          },
        },
      }),
    ).toBe(
      'permission.pending worker=implementer tool=Shell cmd="npm test" id=perm-3',
    );
  });

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

  it('formats conductor.auth.recovery hint for TUI activity log', () => {
    expect(
      formatObservationLogBody({
        type: 'conductor.auth.recovery',
        agentId: 'agent-1',
        hint: '[auth] run cursor login',
      }),
    ).toBe('[auth] run cursor login');
  });

  it('formats conductor.auth.recovery hint for observation stderr', () => {
    expect(
      formatObservationStderrLine({
        type: 'conductor.auth.recovery',
        agentId: 'agent-1',
        hint: '[auth] test recovery hint',
      }),
    ).toBe('[auth] test recovery hint');
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
