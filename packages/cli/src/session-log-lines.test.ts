import { describe, expect, it } from 'vitest';
import { parsePermissionRequest } from '@agents-ensemble/core';
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

  it('renders the dogfooding ACP permission payload as a readable line', () => {
    expect(
      formatHarnessLogBody({
        type: 'permission.pending',
        workerLabel: 'implementer',
        permission: {
          id: '4bf9479c-7f7f-4f1f-8a08-123456789abc',
          workerId: 'worker-uuid',
          createdAt: 0,
          request: parsePermissionRequest({
            sessionId: '01a07a33-d3c1-7ff2-a36a-0f43c2486e45',
            toolCall: {
              toolCallId: 'exec-c7c466aa-8399-4554-89c8-c56a81033df9',
              rawInput: { command: 'pnpm test' },
            },
          }),
        },
      }),
    ).toBe(
      'permission.pending worker=implementer tool=Shell cmd="pnpm test" id=4bf9479c...',
    );
  });

  it('formats harness.warning body', () => {
    expect(
      formatHarnessLogBody({
        type: 'harness.warning',
        message: 'test warning',
      }),
    ).toBe('warning: test warning');
  });

  it('formats conductor.send.started harness body', () => {
    expect(
      formatHarnessLogBody({
        type: 'conductor.send.started',
        sendCount: 2,
        dispatchSource: 'operator',
      }),
    ).toBe('conductor.send.started n=2 source=operator');
  });

  it('suppresses conductor.send.progress from harness log body', () => {
    expect(
      formatHarnessLogBody({
        type: 'conductor.send.progress',
        sendCount: 2,
        runId: 'run-abc',
        tool: 'shell',
      }),
    ).toBeUndefined();
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
    ).toBe('自律作業が一段落しました。');
  });

  it('formats dispatch hold observations', () => {
    expect(
      formatObservationLogBody({
        type: 'conductor.dispatch_hold',
        status: 'enabled',
        hold: true,
        heldEventCount: 0,
      }),
    ).toBe('dispatch hold enabled');
    expect(
      formatObservationStderrLine({
        type: 'conductor.dispatch_hold',
        status: 'released',
        hold: false,
        heldEventCount: 0,
        flushedEventCount: 3,
      }),
    ).toBe('[observation] released (flushed 3 events)');
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

  it('formats conductor.auth.reconnect for observation stderr', () => {
    expect(
      formatObservationStderrLine({
        type: 'conductor.auth.reconnect',
        agentId: 'agent-1',
      }),
    ).toBe('[auth] conductor 再接続を試行 agentId=agent-1');
  });

  it('suppresses harness.worker.acp.update from harness log body', () => {
    expect(
      formatHarnessLogBody({
        type: 'harness.worker.acp.update',
        name: 'implementer',
        kind: 'implementer',
        workerId: 'w-1',
        sessionUpdate: 'agent_message_chunk',
      }),
    ).toBeUndefined();
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
