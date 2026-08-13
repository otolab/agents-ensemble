import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './session-event.js';
import type { SessionLogEvent } from './session-log-event.js';
import {
  ALL_SESSION_LOG_EVENT_TYPES,
  SESSION_EVENT_TYPES,
} from './session-log-event-groups.js';
import type {
  PermissionPendingHarnessPayload,
} from './shared/permission-pending.js';
import type {
  WorkerFailureOutcome,
  WorkerRoundOutcome,
} from './shared/worker-outcome.js';

describe('session event type groups', () => {
  it('lists every SessionLogEvent type exactly once', () => {
    const types = new Set(ALL_SESSION_LOG_EVENT_TYPES);
    expect(types.size).toBe(ALL_SESSION_LOG_EVENT_TYPES.length);
    expect(types.size).toBe(31);
  });

  it('lists every SessionEvent type exactly once', () => {
    const types = new Set(SESSION_EVENT_TYPES);
    expect(types.size).toBe(SESSION_EVENT_TYPES.length);
    expect(types.size).toBe(5);
  });

  it('accepts minimal payloads for each SessionLogEvent type', () => {
    const issue = {
      owner: 'o',
      repo: 'r',
      number: 1,
      url: 'https://github.com/o/r/issues/1',
    };
    const worktree = {
      path: '/tmp/wt',
      branch: 'main',
      issue,
    };
    const round: WorkerRoundOutcome = {
      name: 'implementer',
      kind: 'implementer',
      issue,
      worktree,
      prompt: 'p',
      promptResult: { stopReason: 'end_turn' },
      acpSessionId: 'sid',
    };
    const failure: WorkerFailureOutcome = {
      workerId: 'wid',
      name: 'implementer',
      kind: 'implementer',
      error: 'e',
      issueUrl: issue.url,
    };
    const pendingPermission = {
      id: 'perm-1',
      workerId: 'wid',
      createdAt: 0,
      request: { toolName: 'Shell', raw: {} },
    };
    const permissionHarness: PermissionPendingHarnessPayload = {
      permission: pendingPermission,
      workerLabel: 'implementer',
    };

    const events: SessionLogEvent[] = ALL_SESSION_LOG_EVENT_TYPES.map((type) => {
      switch (type) {
        case 'harness.worktree':
          return { type, path: '/tmp', branch: 'b', mode: 'isolated' };
        case 'harness.worktree.removed':
          return { type, path: '/tmp', branch: 'b' };
        case 'harness.worktree.remove_skipped':
          return { type, path: '/tmp', branch: 'b', reason: 'dirty' };
        case 'harness.worktree.remove_failed':
          return { type, path: '/tmp', branch: 'b', error: 'e' };
        case 'harness.worker.prompt.started':
          return {
            type,
            name: 'implementer',
            kind: 'implementer',
            workerId: 'wid',
            source: 'harness',
          };
        case 'harness.worker.prompt.completed':
          return {
            type,
            name: 'implementer',
            kind: 'implementer',
            workerId: 'wid',
            source: 'harness',
            stopReason: 'end_turn',
          };
        case 'harness.worker.prompt.failed':
          return {
            type,
            name: 'implementer',
            kind: 'implementer',
            workerId: 'wid',
            source: 'harness',
            error: 'e',
          };
        case 'harness.worker.acp.update':
          return {
            type,
            name: 'implementer',
            kind: 'implementer',
            workerId: 'wid',
            sessionUpdate: 'agent_message_chunk',
          };
        case 'harness.worker.state':
          return {
            type,
            name: 'implementer',
            kind: 'implementer',
            workerId: 'wid',
            state: 'processing',
          };
        case 'harness.session.workers':
          return {
            type,
            workers: [{ name: 'implementer', kind: 'implementer' }],
          };
        case 'operator.input':
          return { type, conductorTurn: 1, text: 'hi' };
        case 'conductor.send.started':
          return { type, sendCount: 1 };
        case 'conductor.send.progress':
          return { type, sendCount: 1, runId: 'r', tool: 't' };
        case 'conductor.send':
          return {
            type,
            sendCount: 1,
            runId: 'r',
            status: 'finished',
            workerDispatches: 0,
            workerFailures: 0,
          };
        case 'permission.pending':
          return { type, ...permissionHarness };
        case 'worker.round':
          return { type, dispatch: round };
        case 'worker.failed':
          return { type, failure };
        case 'worker.process.stderr':
          return { type, line: 'err', stream: 'stderr' };
        case 'session.stop':
          return { type, stopReason: 'completed' };
        case 'open.question.enqueued':
          return {
            type,
            question: {
              id: 'q1',
              question: 'q?',
              status: 'open',
              source: 'ask_human',
              responseType: 'yes_no',
              askedAt: 0,
            },
          };
        case 'escalation.recorded':
          return {
            type,
            record: {
              question: 'q?',
              responseType: 'yes_no',
              answer: 'yes',
            },
          };
        case 'session.worktree.notice':
          return { type, mode: 'isolated' };
        case 'session.continue':
          return { type, conductorAgentId: 'aid' };
        case 'session.post_loop_wait':
          return { type };
        case 'session.operator_exit':
          return { type };
        case 'harness.teardown':
          return { type, force: true, durationMs: 1, phases: { workers: 1 } };
        case 'conductor.auth.recovery':
          return { type, agentId: 'aid', hint: 'login' };
        case 'conductor.auth.reconnect':
          return { type, agentId: 'aid' };
        case 'harness.github.update':
          return { type, itemCount: 1 };
        case 'harness.github.monitor_error':
          return { type, message: 'e' };
        case 'harness.warning':
          return { type, message: 'w' };
        default: {
          const _exhaustive: never = type;
          throw new Error(`missing fixture: ${String(_exhaustive)}`);
        }
      }
    });

    expect(events).toHaveLength(ALL_SESSION_LOG_EVENT_TYPES.length);
  });

  it('accepts minimal payloads for each SessionEvent type', () => {
    const issue = {
      owner: 'o',
      repo: 'r',
      number: 1,
      url: 'https://github.com/o/r/issues/1',
    };
    const round: WorkerRoundOutcome = {
      name: 'implementer',
      kind: 'implementer',
      issue,
      worktree: { path: '/tmp/wt', branch: 'main', issue },
      prompt: 'p',
      promptResult: { stopReason: 'end_turn' },
      acpSessionId: 'sid',
    };
    const failure: WorkerFailureOutcome = {
      workerId: 'wid',
      name: 'implementer',
      kind: 'implementer',
      error: 'e',
      issueUrl: 'https://github.com/o/r/issues/1',
    };

    const events: SessionEvent[] = SESSION_EVENT_TYPES.map((type) => {
      switch (type) {
        case 'operator.message':
          return { type, text: 'hi' };
        case 'worker.completed':
          return { type, result: round };
        case 'worker.failed':
          return { type, failure };
        case 'permission.pending':
          return {
            type,
            permission: {
              id: 'perm-1',
              workerId: 'wid',
              createdAt: 0,
              request: { toolName: 'Shell', raw: {} },
            },
          };
        case 'github.update':
          return { type, items: [] };
        default: {
          const _exhaustive: never = type;
          throw new Error(`missing fixture: ${String(_exhaustive)}`);
        }
      }
    });

    expect(events).toHaveLength(SESSION_EVENT_TYPES.length);
  });

  it('documents intentional naming split for worker round completion', () => {
    const issue = {
      owner: 'o',
      repo: 'r',
      number: 1,
      url: 'https://github.com/o/r/issues/1',
    };
    const round: WorkerRoundOutcome = {
      name: 'implementer',
      kind: 'implementer',
      issue,
      worktree: { path: '/tmp/wt', branch: 'main', issue },
      prompt: 'p',
      promptResult: { stopReason: 'end_turn' },
      acpSessionId: 'sid',
    };

    const logEvent: SessionLogEvent = { type: 'worker.round', dispatch: round };
    const conductorEvent: SessionEvent = { type: 'worker.completed', result: round };

    expect(logEvent.dispatch).toEqual(conductorEvent.result);
  });
});
