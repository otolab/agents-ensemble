import { vi } from 'vitest';
import type { PermissionDecision } from '../../../src/acp/types.js';
import type { WorkerDispatchResult } from '../../../src/dispatch/worker-dispatch.js';
import { PermissionPipeline } from '../../../src/permission/permission-pipeline.js';
import { WorkerSession } from '../../../src/runtime/worker-session.js';
import type { WorkerFailureRecord } from '../../../src/runtime/types.js';
import {
  createInProcessAcpBridge,
  PING_SYSTEM_PROMPT,
  TEST_ISSUE,
  TEST_WORKTREE,
} from './in-process-acp-bridge.js';
import type { PermissionPolicyRules } from '../../../src/permission/permission-policy.js';

export interface PermissionScenarioResult {
  completed: WorkerDispatchResult[];
  failures: WorkerFailureRecord[];
  permissionDecisions: PermissionDecision[];
  pipeline: PermissionPipeline;
  session: WorkerSession;
}

export interface PermissionScenarioOptions {
  policy?: PermissionPolicyRules;
  requestPermissionOnPrompt?: boolean;
  /** pending 発生後に conductor 相当の解決を行う */
  resolvePending?: (input: {
    pipeline: PermissionPipeline;
    session: WorkerSession;
    pendingId: string;
  }) => void | Promise<void>;
}

async function waitForPending(
  pipeline: PermissionPipeline,
  inbox: WorkerSession['inbox'],
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await inbox.drain();
    const pending = pipeline.pending.list();
    if (pending.length > 0) {
      return pending[0]!.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for pending permission');
}

export async function runPermissionWorkerSession(
  options: PermissionScenarioOptions = {},
): Promise<PermissionScenarioResult> {
  const permissionDecisions: PermissionDecision[] = [];
  const completed: WorkerDispatchResult[] = [];
  const failures: WorkerFailureRecord[] = [];
  const pipeline = new PermissionPipeline({ policy: options.policy });
  const bridge = await createInProcessAcpBridge(undefined, {
    requestPermissionOnPrompt: options.requestPermissionOnPrompt ?? true,
  });

  const session = new WorkerSession({
    issueUrl: TEST_ISSUE.url,
    worktree: TEST_WORKTREE,
    workers: [
      {
        name: 'ping-1',
        kind: 'ping',
        systemPrompt: PING_SYSTEM_PROMPT,
      },
    ],
    sessionState: {
      workers: [{ name: 'ping-1', kind: 'ping' }],
      kinds: ['ping'],
    },
    permissionPipeline: pipeline,
    connectAcp: async () => bridge,
    ownsWorkerAcpConnections: false,
    decidePermission: async (request, workerId, requestId) => {
      const outcome = pipeline.evaluate(requestId, workerId, request);
      if (outcome.status === 'resolved') {
        permissionDecisions.push(outcome.decision);
        return outcome.decision;
      }
      return null;
    },
    onWorkerCompleted: (result) => {
      completed.push(result);
    },
    onWorkerFailed: (failure) => {
      failures.push(failure);
    },
  });

  session.bootstrap();

  if (options.resolvePending) {
    const pendingId = await waitForPending(pipeline, session.inbox);
    await options.resolvePending({
      pipeline,
      session,
      pendingId,
    });
  }

  await session.stop();

  return {
    completed,
    failures,
    permissionDecisions,
    pipeline,
    session,
  };
}
